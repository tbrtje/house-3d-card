/**
 * House 3D Card for Home Assistant.
 * Two renderers for the same house description: a schematic CSS-3D model and
 * a realistic three.js model with sun, shadows and lit windows.
 * The house geometry lives in the card config, never in this file.
 * SPDX-License-Identifier: MIT
 */
const VERSION = "1.3.0";
const THREE_URL = new URL("./three.module.min.js", import.meta.url).href;
const WARM = [255, 183, 92];

// ---------- shared geometry helpers (plan metres: x right, y/z down) ----------
const signedArea = (p) => p.reduce((t, a, i) => {
  const b = p[(i + 1) % p.length];
  return t + a[0] * b[1] - b[0] * a[1];
}, 0);
const area = (p) => Math.abs(signedArea(p)) / 2;
const centroid = (p) => {
  let x = 0, y = 0, a = 0;
  p.forEach((c, i) => {
    const d = p[(i + 1) % p.length];
    const k = c[0] * d[1] - d[0] * c[1];
    a += k; x += (c[0] + d[0]) * k; y += (c[1] + d[1]) * k;
  });
  return [x / (3 * a), y / (3 * a)];
};
const inside = (pt, p) => {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > pt[1]) !== (p[j][1] > pt[1]) &&
      pt[0] < (p[j][0] - p[i][0]) * (pt[1] - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
};
// miter offset of a polygon outline by d metres (outwards for d > 0)
const grow = (p, d) => {
  const s = Math.sign(signedArea(p));
  const nrm = (a, b) => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [s * (b[1] - a[1]) / l, -s * (b[0] - a[0]) / l];
  };
  return p.map((c, i) => {
    const n1 = nrm(p[(i - 1 + p.length) % p.length], c), n2 = nrm(c, p[(i + 1) % p.length]);
    const k = d / (1 + n1[0] * n2[0] + n1[1] * n2[1] || 1);
    return [c[0] + (n1[0] + n2[0]) * k, c[1] + (n1[1] + n2[1]) * k];
  });
};
const rect = (r) => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
const inRect = ([x, y], r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const ellipse = ([cx, cy, rx, ry], n = 28) => Array.from({ length: n }, (_, i) =>
  [cx + rx * Math.cos((i / n) * 2 * Math.PI), cy + ry * Math.sin((i / n) * 2 * Math.PI)]);
// a berm (earth wall) is a centre line with a base width; its footprint follows the line
const lineNormals = (line) => line.map((c, i) => {
  const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
});
const strip = (line, w) => {
  const n = lineNormals(line);
  return [...line.map((c, i) => [c[0] + n[i][0] * w, c[1] + n[i][1] * w]),
    ...line.map((c, i) => [c[0] - n[i][0] * w, c[1] - n[i][1] * w]).reverse()];
};
const outline = (z) => z.poly || (z.line ? strip(z.line, (z.base || 8) / 2) :
  z.ellipse ? ellipse(z.ellipse) : rect(z.rect));
// distance from a point to a polyline
const lineDist = ([x, y], line) => {
  let d = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], dx = line[i][0] - a[0], dy = line[i][1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return d;
};
// temperature → hue: 16 °C blue … 26 °C red
const tempColor = (t) => `hsl(${220 - Math.max(0, Math.min(1, (t - 16) / 10)) * 220} 75% 55%)`;
const bounds = (rooms) => {
  const pts = rooms.flatMap((r) => r.p);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

function lightState(hass, ids) {
  const on = (ids || []).map((e) => hass.states[e]).filter((s) => s && s.state === "on");
  if (!on.length) return null;
  const rgb = [0, 0, 0];
  let bri = 0;
  on.forEach((s) => {
    (s.attributes.rgb_color || WARM).forEach((v, i) => (rgb[i] += v / on.length));
    bri += (s.attributes.brightness ?? 255) / 255 / on.length;
  });
  return { rgb: rgb.map(Math.round), bri, count: on.length };
}

const BAR_CSS = `
  :host { display: block; height: 100%; }
  ha-card { overflow: hidden; height: 100%; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 12px 16px 4px; flex-wrap: wrap; }
  .title { font-size: 1.15em; font-weight: 500; flex: 1; min-width: 120px; }
  .title small { display: block; font-size: .72em; font-weight: 400; color: var(--secondary-text-color); }
  .seg { display: inline-flex; border-radius: 18px; background: var(--secondary-background-color); padding: 3px; }
  .seg button { border: 0; background: none; color: var(--primary-text-color); font: inherit; font-size: .85em;
    padding: 5px 11px; border-radius: 15px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .seg button.on { background: var(--card-background-color); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
  .seg ha-icon { --mdc-icon-size: 18px; }
  .stage { position: relative; flex: 1; overflow: hidden; touch-action: none; cursor: grab;
    user-select: none; -webkit-user-select: none; }
  .stage.drag { cursor: grabbing; }
  .hint { position: absolute; bottom: 8px; left: 0; right: 0; text-align: center; font-size: 11px;
    color: var(--secondary-text-color); pointer-events: none; }`;

// shared behaviour: config access, tap/hold actions, pointer gestures
class HouseBase extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    this._config = { height: 460, rooms: {}, ...config };
    this._house = this._config.house || { rooms: [] };
    this._configChanged();
  }

  _configChanged() {
    this._built = false;
    if (this._hass) this._render();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._built) return this._render();
    if (!old || this._watched().some((e) => old.states[e] !== hass.states[e])) this._update();
  }

  _zones() {
    return this._config.outdoor?.zones || [];
  }

  _room(id) {
    return this._config.rooms[id] || this._zones().find((z) => z.id === id) || {};
  }

  _name(id) {
    return this._config.rooms[id]?.name || this._house.rooms.find((r) => r.id === id)?.name || id;
  }

  _floors() {
    return this._house.floors || [{ name: "EG" }, { name: "OG", level: 2.95 }];
  }

  _watched() {
    const ids = ["sun.sun"];
    [...Object.values(this._config.rooms), ...this._zones()].forEach((r) => {
      ids.push(...(r.lights || []), ...(r.info || []).map((i) => i.entity || i));
      ["temperature", "motion", "window"].forEach((k) => r[k] && ids.push(r[k]));
    });
    return ids;
  }

  _styleButton(target, icon, label) {
    return `<div class="seg"><button class="style" data-target="${target}" title="${label}">
      <ha-icon icon="${icon}"></ha-icon></button></div>`;
  }

  _bindStyleButton() {
    this.shadowRoot.querySelector(".style")?.addEventListener("click", (e) =>
      this.dispatchEvent(new CustomEvent("house-3d-style", { detail: e.currentTarget.dataset.target })));
  }

  _fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  _tap(id) {
    const lights = this._room(id).lights || [];
    if (!lights.length) return this._hold(id);
    const anyOn = lights.some((e) => this._hass.states[e]?.state === "on");
    this._hass.callService("light", anyOn ? "turn_off" : "turn_on", { entity_id: lights });
    this._fire("haptic", "light");
  }

  _hold(id) {
    const cfg = this._room(id);
    this._fire("haptic", "medium");
    if (cfg.more_info) {
      this._fire("hass-more-info", { entityId: cfg.more_info });
    } else if (cfg.path) {
      history.pushState(null, "", cfg.path);
      this._fire("location-changed", { replace: false });
    } else if (cfg.temperature || cfg.lights?.length) {
      this._fire("hass-more-info", { entityId: cfg.temperature || cfg.lights[0] });
    }
  }

  // drag rotates, pinch/wheel zooms, tap and hold act on the room under the pointer
  _bindPointer(stage, { pick, rotate, zoom, getView }) {
    const pts = new Map();
    let start = null, holdTimer = null, pinch = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest?.(".reset")) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      stage.setPointerCapture(e.pointerId);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), view: getView() };
        clearTimeout(holdTimer);
        start = null;
        return;
      }
      start = { x: e.clientX, y: e.clientY, view: getView(), moved: false, held: false };
      const room = pick(e.clientX, e.clientY);
      holdTimer = setTimeout(() => {
        if (start && !start.moved && room) {
          start.held = true;
          this._hold(room);
        }
      }, 550);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        return zoom(Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, pinch.view);
      }
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 6) return;
      start.moved = true;
      clearTimeout(holdTimer);
      stage.classList.add("drag");
      rotate(dx, dy, start.view);
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      stage.classList.remove("drag");
      clearTimeout(holdTimer);
      if (pts.size < 2) pinch = null;
      if (start && !start.moved && !start.held && e.type === "pointerup") {
        const room = pick(e.clientX, e.clientY);
        if (room) this._tap(room);
      }
      start = null;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, getView());
    }, { passive: false });
  }
}

// =====================================================================
// Schematic renderer: CSS 3D transforms, no dependencies
// =====================================================================
const S_WALL = 1.0;                 // cut-away wall height
const S_STACK = 4.6;                // gap between storeys in the stacked view
const S_Z = { lawn: -0.1, road: -0.08, paved: -0.06, water: -0.05, deck: -0.02, slab: -0.03 };

class HouseSchematic extends HouseBase {
  constructor() {
    super();
    this._view = { az: -18, tilt: 56, zoom: 1 };
    this._floor = "0";
    this._mode = "light";
  }

  setConfig(config) {
    super.setConfig(config);
    this._floor = String(this._config.default_floor ?? this._floor);
  }

  connectedCallback() {
    this._ro = new ResizeObserver(() => this._layout());
    if (this._stage) this._ro.observe(this._stage);
  }

  disconnectedCallback() {
    this._ro?.disconnect();
  }

  _render() {
    if (!this._config || !this._hass) return;
    const h = this._config.height;
    const floors = this._floors().map((f, i) => [String(i), f.name]);
    if (floors.length > 1) floors.push(["all", "Alle"]);
    this.shadowRoot.innerHTML = `
      <style>${BAR_CSS}
        .stage { min-height: ${typeof h === "number" ? h + "px" : h}; perspective: 1700px; transition: background 1.2s; }
        .stage.day { background: radial-gradient(ellipse at 50% 30%, rgba(140,190,255,.16), transparent 70%); }
        .stage.night { background: radial-gradient(ellipse at 50% 30%, rgba(40,60,120,.38), rgba(10,14,30,.22) 75%); }
        .world, .lvl { position: absolute; left: 50%; top: 58%; width: 0; height: 0; transform-style: preserve-3d; }
        .lvl { left: 0; top: 0; transition: transform .6s ease; }
        .lvl.hide { display: none; }
        .fl, .wl { position: absolute; transform-origin: 0 0; }
        .fl { transition: background .5s; }
        .fl.slab { background: var(--slab); }
        .fl.top { pointer-events: none; }
        .wl { backface-visibility: visible; border-top: 2px solid var(--wall-edge); transition: background .5s; }
        .lb { position: absolute; left: 0; top: 0; transform-style: flat; pointer-events: none; white-space: nowrap;
          display: flex; flex-direction: column; align-items: center; }
        .chip { background: var(--card-background-color); color: var(--primary-text-color); border-radius: 12px;
          padding: 3px 9px; font-size: 12px; line-height: 1.3; box-shadow: 0 2px 6px rgba(0,0,0,.25);
          display: flex; align-items: center; gap: 4px; }
        .chip.dim { background: none; box-shadow: none; color: var(--secondary-text-color); font-size: 11px; padding: 0; }
        .chip ha-icon { --mdc-icon-size: 14px; }
        .chip .t { font-weight: 600; }
        .chip .lit { color: rgb(${WARM}); }
        .chip .mot { color: var(--warning-color, #ff9800); animation: pulse 1.4s infinite; }
        .chip .win { color: var(--info-color, #039be5); }
        .chip .inf { color: var(--secondary-text-color); }
        @keyframes pulse { 50% { opacity: .35; } }
        .reset { position: absolute; right: 10px; bottom: 6px; }
      </style>
      <ha-card>
        <div class="bar">
          <div class="title">${this._config.title || "Haus 3D"}<small class="sum"></small></div>
          <div class="seg">${floors.map(([k, n]) => `<button data-floor="${k}">${n}</button>`).join("")}</div>
          <div class="seg">
            <button data-mode="light" title="Licht"><ha-icon icon="mdi:lightbulb-group"></ha-icon></button>
            <button data-mode="temp" title="Temperatur"><ha-icon icon="mdi:thermometer"></ha-icon></button>
          </div>
          ${this._styleButton("realistic", "mdi:image-filter-hdr", "Realistische Ansicht")}
        </div>
        <div class="stage">
          <div class="world"></div>
          <div class="hint">Ziehen zum Drehen · Tippen schaltet Licht · Halten öffnet den Raum</div>
          <ha-icon-button class="reset" label="Ansicht zurücksetzen"><ha-icon icon="mdi:rotate-3d-variant"></ha-icon></ha-icon-button>
        </div>
      </ha-card>`;
    const root = this.shadowRoot;
    this._stage = root.querySelector(".stage");
    this._world = root.querySelector(".world");
    root.querySelectorAll("[data-floor]").forEach((b) => b.addEventListener("click", () => {
      this._floor = b.dataset.floor;
      this._applyFloor();
    }));
    root.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      this._mode = b.dataset.mode;
      this._update();
    }));
    root.querySelector(".reset").addEventListener("click", () => {
      this._view = { az: -18, tilt: 56, zoom: 1 };
      this._transform();
    });
    this._bindStyleButton();
    this._bindPointer(this._stage, {
      pick: (x, y) => this.shadowRoot.elementFromPoint(x, y)?.closest?.("[data-room]")?.dataset.room,
      getView: () => ({ ...this._view }),
      rotate: (dx, dy, v) => {
        this._view.az = v.az - dx * 0.35;
        this._view.tilt = Math.max(0, Math.min(80, v.tilt - dy * 0.3));
        this._transform();
      },
      zoom: (f, v) => {
        this._view.zoom = Math.max(0.35, Math.min(2.5, v.zoom * f));
        this._transform();
      },
    });
    this._built = true;
    this._ro?.observe(this._stage);
    this._layout();
  }

  // (re)build geometry; px per metre depends on the stage size
  _layout() {
    if (!this._stage) return;
    const r = this._stage.getBoundingClientRect();
    if (!r.width) return;
    const b = bounds(this._house.rooms.length ? this._house.rooms : [{ p: [[0, 0], [10, 10]] }]);
    this._c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const ext = this._config.outdoor?.fit || (this._zones().length ? [b[0] - 3, b[1] - 3, b[2] + 3, b[3] + 7] : b);
    this._px = Math.max(8, Math.min(r.width / ((ext[2] - ext[0]) * 0.95), r.height / ((ext[3] - ext[1]) * 0.8)));
    this._world.innerHTML = "";
    const mk = () => {
      const el = document.createElement("div");
      el.className = "lvl";
      this._world.appendChild(el);
      return el;
    };
    const outside = mk();
    this._levels = this._floors().map(mk);
    this._els = {};
    // outdoor zones: flat ground (lawn, road, paved, water, deck) or solid
    // objects with walls and a top (building, hedge); roof adds a canopy
    this._zones().forEach((z) => {
      const kind = z.kind === "berm" ? "lawn" : z.kind || "paved";
      const p = outline(z);
      const solidObj = kind === "building" || kind === "hedge";
      const fl = this._plane(outside, p, solidObj ? 0 : S_Z[kind] ?? S_Z.paved, z.id);
      const walls = solidObj ? this._walls(outside, p, z.height || 2, z.id) : [];
      const tops = [];
      if (solidObj) tops.push(this._plane(outside, p, z.height || 2, z.id));
      if (z.roof) tops.push(this._plane(outside, p, z.roof, z.id));
      tops.forEach((t) => t.classList.add("top"));
      let lb = null;
      if (z.label !== false) {
        lb = this._label(outside, z.label || centroid(p), Math.max(z.height || 0, z.roof || 0) + 0.25);
      }
      this._els[z.id] = { g: { id: z.id, n: z.name || z.id, out: true, kind }, cfg: z, fl, walls, tops, lb };
    });
    this._house.rooms.forEach((g) => {
      const lvl = this._levels[g.floor || 0];
      if (!lvl) return;
      // dark slab under each room so wall gaps read as walls, not lawn
      this._plane(lvl, grow(g.p, 0.2), S_Z.slab).classList.add("slab");
      const fl = this._plane(lvl, g.p, 0, g.id);
      const walls = this._walls(lvl, g.p, S_WALL, g.id);
      const lb = this._config.rooms[g.id] || area(g.p) > 8 ? this._label(lvl, centroid(g.p), S_WALL + 0.2) : null;
      this._els[g.id] = { g: { ...g, n: g.name || g.id }, cfg: this._room(g.id), fl, walls, lb };
    });
    this._applyFloor();
  }

  _label(parent, c, z) {
    const lb = document.createElement("div");
    lb.className = "lb";
    lb._c = c;
    lb._z = z;
    parent.appendChild(lb);
    return lb;
  }

  _walls(parent, p, h, room) {
    const px = this._px, [cx, cy] = this._c;
    return p.map((a, i) => {
      const b = p[(i + 1) % p.length];
      const wl = document.createElement("div");
      wl.className = "wl";
      wl.dataset.room = room;
      Object.assign(wl.style, {
        left: (a[0] - cx) * px + "px",
        top: (a[1] - cy) * px + "px",
        width: Math.hypot(b[0] - a[0], b[1] - a[1]) * px + "px",
        height: h * px + "px",
        transform: `rotateZ(${Math.atan2(b[1] - a[1], b[0] - a[0])}rad) rotateX(90deg)`,
      });
      parent.appendChild(wl);
      return wl;
    });
  }

  // flat polygon at height z (metres) inside a level
  _plane(parent, p, z, room) {
    const px = this._px, [cx, cy] = this._c;
    const xs = p.map((c) => c[0]), ys = p.map((c) => c[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const el = document.createElement("div");
    el.className = "fl";
    if (room) el.dataset.room = room;
    Object.assign(el.style, {
      left: (x0 - cx) * px + "px",
      top: (y0 - cy) * px + "px",
      width: (Math.max(...xs) - x0) * px + "px",
      height: (Math.max(...ys) - y0) * px + "px",
      clipPath: `polygon(${p.map((c) => `${(c[0] - x0) * px}px ${(c[1] - y0) * px}px`).join(",")})`,
      transform: z ? `translateZ(${z * px}px)` : "",
    });
    parent.appendChild(el);
    return el;
  }

  _applyFloor() {
    const all = this._floor === "all";
    this._levels?.forEach((lvl, f) => {
      lvl.classList.toggle("hide", !all && this._floor !== String(f));
      lvl.style.transform = `translateZ(${(all ? f * S_STACK : 0) * this._px}px)`;
    });
    this.shadowRoot.querySelectorAll("[data-floor]").forEach((b) =>
      b.classList.toggle("on", b.dataset.floor === this._floor));
    this._transform();
    this._update();
  }

  _transform() {
    const { az, tilt, zoom } = this._view;
    if (!this._world) return;
    this._world.style.transform = `rotateX(${tilt}deg) rotateZ(${az}deg) scale3d(${zoom},${zoom},${zoom})`;
    // labels stay upright and face the camera
    const px = this._px, [cx, cy] = this._c || [0, 0];
    Object.values(this._els || {}).forEach(({ lb }) => {
      if (!lb) return;
      lb.style.transform = `translate3d(${(lb._c[0] - cx) * px}px, ${(lb._c[1] - cy) * px}px, ${lb._z * px}px)` +
        ` rotateZ(${-az}deg) rotateX(${-tilt}deg) scale(${1 / zoom}) translate(-50%, -100%)`;
    });
  }

  _update() {
    if (!this._els || !this._hass) return;
    const st = this._hass.states;
    const dark = this._hass.themes?.darkMode;
    this.shadowRoot.querySelectorAll("[data-mode]").forEach((b) =>
      b.classList.toggle("on", b.dataset.mode === this._mode));
    const sun = st["sun.sun"];
    this._stage.classList.toggle("night", sun?.state === "below_horizon");
    this._stage.classList.toggle("day", sun?.state === "above_horizon");
    this._stage.style.setProperty("--wall-edge", dark ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.28)");
    const base = dark ? "rgba(255,255,255," : "rgba(30,40,60,";
    // floors are opaque so the lawn does not shine through, except the
    // floating upper storeys in the stacked view
    const solid = dark
      ? { on: "#3a3d44", off: "#2e3036", lawn: "#2c4a2f", paved: "#45464b", road: "#1f2024", water: "#24425c", deck: "#5a4632",
        building: "#4a4740", hedge: "#24401f", slab: "#1e1f23" }
      : { on: "#e4e7ec", off: "#eef0f3", lawn: "#b9d7a8", paved: "#d3d3d6", road: "#8e9197", water: "#8fbfe0", deck: "#c8a77e",
        building: "#c9c2b6", hedge: "#6f9a5f", slab: "#9a9ca3" };
    this._stage.style.setProperty("--slab", solid.slab);
    const seeThrough = this._floor === "all";
    let litRooms = 0;
    Object.values(this._els).forEach(({ g, cfg, fl, walls, tops, lb }) => {
      const linked = !!(this._config.rooms[g.id] ||
        (g.out && ["lights", "temperature", "motion", "info", "more_info", "path"].some((k) => cfg[k])));
      const light = lightState(this._hass, cfg.lights);
      const tState = cfg.temperature && st[cfg.temperature];
      const temp = tState ? parseFloat(tState.state) : NaN;
      let under = g.out ? solid[g.kind] || solid.paved : linked ? solid.on : solid.off;
      if (seeThrough && g.floor > 0) under = `${base}${linked ? 0.13 : 0.06})`;
      let floor = under;
      let wall = g.kind === "hedge" ? solid.hedge : g.kind === "building" ? solid.building
        : `${base}${linked ? 0.16 : 0.08})`;
      (tops || []).forEach((t, i) => (t.style.background = g.kind === "hedge" ? solid.hedge
        : cfg.roof && i === tops.length - 1 ? `${base}0.14)` : solid.road));
      if (this._mode === "light" && light) {
        const a = 0.35 + 0.55 * light.bri;
        floor = `radial-gradient(circle at 50% 50%, rgba(${light.rgb},${a}), rgba(${light.rgb},${a * 0.45})), ${under}`;
        wall = `linear-gradient(to top, rgba(${light.rgb},${a * 0.15}), rgba(${light.rgb},${a * 0.6}))`;
      } else if (this._mode === "temp" && !isNaN(temp)) {
        const c = tempColor(temp);
        const tint = c.replace(")", g.kind === "lawn" ? " / .25)" : " / .55)");
        floor = `linear-gradient(${tint}, ${tint}), ${under}`;
        wall = c.replace(")", " / .3)");
      }
      if (light && !g.out) litRooms++;
      fl.style.background = floor;
      walls.forEach((w) => (w.style.background = wall));
      if (!lb) return;
      const bits = [];
      if (!isNaN(temp)) bits.push(`<span class="t">${temp.toLocaleString("de-DE", { maximumFractionDigits: 1 })}°</span>`);
      if (light) bits.push(`<ha-icon class="lit" icon="mdi:lightbulb-on"></ha-icon>${light.count > 1 ? light.count : ""}`);
      if (cfg.motion && st[cfg.motion]?.state === "on") bits.push(`<ha-icon class="mot" icon="mdi:motion-sensor"></ha-icon>`);
      if (cfg.window && st[cfg.window]?.state === "on") bits.push(`<ha-icon class="win" icon="mdi:window-open-variant"></ha-icon>`);
      (cfg.info || []).forEach((i) => {
        const s = st[i.entity || i];
        if (!s) return;
        const icon = i.icon ? `<ha-icon class="inf" icon="${i.icon}"></ha-icon>` : "";
        bits.push(`${icon}<span class="inf">${this._hass.formatEntityState(s)}</span>`);
      });
      const name = cfg.name || g.n;
      lb.innerHTML = linked
        ? `<div class="chip"><span>${name}</span>${bits.join("")}</div>`
        : `<div class="chip dim">${name}</div>`;
    });
    const sum = this.shadowRoot.querySelector(".sum");
    if (sum) sum.textContent = litRooms ? `Licht in ${litRooms} ${litRooms === 1 ? "Raum" : "Räumen"}` : "Alle Lichter aus";
  }
}

// =====================================================================
// Realistic renderer: three.js, loaded lazily from next to this file
// =====================================================================
// alpha mask for the aerial photo: soft outer edge and an optional clip
// polygon in plan metres (e.g. the own plot, so neighbours stay hidden)
function orthoMask(T, { corners: [tl, tr, , bl], clip }) {
  const N = 512, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N);
  const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const ring = clip && [...clip, clip[0]];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = (i + 0.5) / N, v = (j + 0.5) / N;
    let a = Math.min(u * w, (1 - u) * w, v * h, (1 - v) * h) / 6;
    if (clip && a > 0) {
      const p = [tl[0] + (tr[0] - tl[0]) * u + (bl[0] - tl[0]) * v, tl[1] + (tr[1] - tl[1]) * u + (bl[1] - tl[1]) * v];
      a = Math.min(a, inside(p, clip) ? lineDist(p, ring) / 1.2 : 0);
    }
    const k = (j * N + i) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.max(0, Math.min(1, a)) * 255;
    img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return new T.CanvasTexture(c);
}

function canvasTex(T, size, draw, metres) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new T.CanvasTexture(c);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(1 / metres, 1 / metres);
  t.colorSpace = T.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const PAINT = {
  // clinker brick: 1 m tile, 14 courses, 4 bricks per course
  brick: (tones, mortar) => (g, s) => {
    g.fillStyle = mortar; g.fillRect(0, 0, s, s);
    const rows = 14, cols = 4, bh = s / rows, bw = s / cols;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? bw / 2 : 0;
      for (let c = -1; c <= cols; c++) {
        g.fillStyle = tones[(r * 7 + c * 3 + (r * c) % 5) % tones.length];
        g.fillRect(c * bw + off + 1.5, r * bh + 1.5, bw - 3, bh - 3);
      }
    }
  },
  // pantiles, 1 m tile
  tiles: ([hi, mid, lo]) => (g, s) => {
    g.fillStyle = mid; g.fillRect(0, 0, s, s);
    const rows = 3, cols = 4;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * s / cols, y = r * s / rows;
      const grd = g.createLinearGradient(x, 0, x + s / cols, 0);
      grd.addColorStop(0, hi); grd.addColorStop(0.55, mid); grd.addColorStop(1, lo);
      g.fillStyle = grd;
      g.fillRect(x, y, s / cols, s / rows - 4);
      g.fillStyle = "rgba(0,0,0,.45)";
      g.fillRect(x, y + s / rows - 4, s / cols, 4);
    }
  },
  wood: (g, s) => {
    g.fillStyle = "#8a6a48"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? "#7c5e3f" : "#957452";
      g.fillRect(0, i * s / 8 + 1, s, s / 8 - 2);
    }
  },
  leaves: (g, s) => {
    g.fillStyle = "#2f4a26"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = ["#3d5e30", "#253d1e", "#4a6d38", "#1d3018"][i % 4];
      g.fillRect(Math.random() * s, Math.random() * s, 3 + Math.random() * 5, 3 + Math.random() * 5);
    }
  },
  // light grey leaves; each plant tints it with its own colour
  foliage: (g, s) => {
    g.fillStyle = "#b8b8b8"; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = ["#f0f0f0", "#a0a0a0", "#dadada", "#848484", "#c8c8c8"][i % 5];
      g.beginPath();
      g.ellipse(Math.random() * s, Math.random() * s, 1.5 + Math.random() * 2.5, 1 + Math.random() * 1.5, Math.random() * 3, 0, 7);
      g.fill();
    }
  },
};

// small deterministic random generator, so plants look the same on every load
function seeded(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// lumpy unit sphere for tree crowns and shrubs
function crownGeometry(T) {
  const g = new T.SphereGeometry(1, 16, 11), pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(3.1 * x + 1.7) * Math.sin(2.7 * y + 0.4) * Math.sin(3.3 * z + 2.1)
      + 0.5 * Math.sin(7.3 * x + 0.3) * Math.sin(6.1 * z + 1.2) * Math.sin(5.7 * y + 2.5);
    const f = 1 + 0.2 * n;
    pos.setXYZ(i, x * f, (y < -0.2 ? y * 0.8 : y) * f, z * f);
  }
  g.computeVertexNormals();
  return g;
}

// planar UVs in metres, chosen per face from its normal
function worldUV(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (ny >= nx && ny >= nz) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
    else if (nx >= nz) { uv[i * 2] = z; uv[i * 2 + 1] = y; }
    else { uv[i * 2] = x; uv[i * 2 + 1] = y; }
  }
  geo.setAttribute("uv", new pos.constructor(uv, 2));
  return geo;
}

class HouseReal extends HouseBase {
  constructor() {
    super();
    this._mode = "house";
    this._orbit = { theta: 0.55, phi: 1.0, r: 46 };
  }

  _configChanged() {
    if (this._renderer) this._build();
    else if (this._hass && !this._built) this._render();
  }

  // called by the card when it swaps renderers; frees the WebGL context
  _dispose() {
    this._renderer?.dispose();
    this._renderer?.forceContextLoss();
    this._renderer = null;
  }

  connectedCallback() {
    if (this._stage && this._ro) this._ro.observe(this._stage);
    this._dirty();
  }

  disconnectedCallback() {
    this._ro?.disconnect();
    cancelAnimationFrame(this._raf);
    this._rafPending = false;
  }

  _modes() {
    return [["house", "Haus"], ...this._floors().map((f, i) => [String(i), f.name])];
  }

  _clipFor(mode) {
    if (mode === "house") return 1e6;
    return (this._floors()[+mode].level || 0) + 1.45;
  }

  async _render() {
    if (!this._config || !this._hass || this._built) return;
    this._built = true;
    const h = this._config.height;
    this.shadowRoot.innerHTML = `
      <style>${BAR_CSS}
        .stage { min-height: ${typeof h === "number" ? h + "px" : h}; }
        canvas { display: block; position: absolute; inset: 0; width: 100%; height: 100%; }
        .labels { position: absolute; inset: 0; pointer-events: none; }
        .chip { position: absolute; transform: translate(-50%, -100%); background: var(--card-background-color);
          color: var(--primary-text-color); border-radius: 12px; padding: 3px 9px; font-size: 12px; white-space: nowrap;
          box-shadow: 0 2px 6px rgba(0,0,0,.3); display: flex; gap: 4px; align-items: center; }
        .chip .t { font-weight: 600; }
        .chip ha-icon { --mdc-icon-size: 14px; color: rgb(${WARM}); }
        .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
          text-align: center; color: var(--secondary-text-color); }
        .hint { color: rgba(255,255,255,.85); text-shadow: 0 1px 3px rgba(0,0,0,.6); }
      </style>
      <ha-card>
        <div class="bar">
          <div class="title">${this._config.title || "Haus 3D"}<small class="sum"></small></div>
          <div class="seg">${this._modes().map(([k, n]) => `<button data-mode="${k}">${n}</button>`).join("")}</div>
          ${this._styleButton("schematic", "mdi:vector-square", "Schematische Ansicht")}
        </div>
        <div class="stage"><div class="msg">3D-Modell wird geladen …</div><div class="labels"></div>
          <div class="hint">Ziehen zum Drehen · Tippen schaltet Licht · Halten öffnet den Raum</div></div>
      </ha-card>`;
    this._stage = this.shadowRoot.querySelector(".stage");
    this._labels = this.shadowRoot.querySelector(".labels");
    this.shadowRoot.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      this._mode = b.dataset.mode;
      if (this._mode !== "house") this._orbit.r = Math.min(this._orbit.r, 38);
      this._applyMode();
    }));
    this._bindStyleButton();
    try {
      this._T = await import(this._config.three_url ? new URL(this._config.three_url, location.origin).href : THREE_URL);
    } catch (err) {
      this.shadowRoot.querySelector(".msg").textContent = `three.js konnte nicht geladen werden (${err.message}).`;
      return;
    }
    this.shadowRoot.querySelector(".msg").remove();
    this._initRenderer();
    this._build();
  }

  _initRenderer() {
    const T = this._T;
    const r = new T.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.localClippingEnabled = true;
    r.shadowMap.type = T.PCFSoftShadowMap;
    r.toneMapping = T.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.35;
    this._stage.prepend(r.domElement);
    this._renderer = r;
    this._camera = new T.PerspectiveCamera(40, 1, 0.5, 600);
    this._clip = new T.Plane(new T.Vector3(0, -1, 0), 1e6);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._stage);
    this._bindPointer(this._stage, {
      pick: (x, y) => this._pick(x, y),
      getView: () => ({ ...this._orbit }),
      rotate: (dx, dy, v) => {
        this._orbit.theta = v.theta - dx * 0.008;
        this._orbit.phi = Math.max(0.15, Math.min(1.45, v.phi - dy * 0.006));
        this._dirty();
      },
      zoom: (f, v) => {
        this._orbit.r = Math.max(12, Math.min(120, v.r / f));
        this._dirty();
      },
    });
  }

  _resize() {
    const { width, height } = this._stage.getBoundingClientRect();
    if (!width || !this._renderer) return;
    this._renderer.setSize(width, height, false);
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
    this._dirty();
  }

  // render on demand only
  _dirty() {
    if (!this._renderer || !this._scene || this._rafPending) return;
    this._rafPending = true;
    this._raf = requestAnimationFrame(() => {
      this._rafPending = false;
      this._draw();
    });
  }

  _draw() {
    const { theta, phi, r } = this._orbit;
    const [cx, , cz] = this._center;
    const c = this._camera;
    c.position.set(cx + r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi), cz + r * Math.sin(phi) * Math.cos(theta));
    c.lookAt(cx, 1.5, cz);
    this._renderer.render(this._scene, c);
    this._placeLabels();
  }

  // ---------- scene ----------
  _build() {
    const T = this._T, house = this._house, look = house.materials || {};
    const scene = new T.Scene();
    this._scene = scene;
    this._rooms = {};
    this._orthoUV = null;
    this._orthoMats = [];
    const b = bounds(house.rooms.length ? house.rooms : [{ p: [[0, 0], [10, 10]] }]);
    this._center = [(b[0] + b[2]) / 2, 0, (b[1] + b[3]) / 2];
    const clip = [this._clip];
    const tex = {
      brick: canvasTex(T, 256, PAINT.brick(look.brick || ["#6a5157", "#59464c", "#76595f", "#604b51", "#7d6166", "#4f3f44"],
        look.mortar || "#8a8480"), 1),
      roof: canvasTex(T, 256, PAINT.tiles(look.roof || ["#4e535a", "#3c4046", "#2a2d32"]), 1),
      wood: canvasTex(T, 128, PAINT.wood, 1.2),
      hedge: canvasTex(T, 128, PAINT.leaves, 1.5),
    };
    const mat = {
      brick: new T.MeshStandardMaterial({ map: tex.brick, roughness: 0.9, side: T.DoubleSide, clippingPlanes: clip }),
      roof: new T.MeshStandardMaterial({ map: tex.roof, roughness: 0.45, metalness: 0.1, side: T.DoubleSide, clippingPlanes: clip }),
      floor: new T.MeshStandardMaterial({ color: 0xcfc6b8, roughness: 0.8, clippingPlanes: clip }),
      inner: new T.MeshStandardMaterial({ color: 0xece8e1, roughness: 0.95, side: T.DoubleSide, clippingPlanes: clip }),
      frame: new T.MeshStandardMaterial({ color: 0x4d5258, roughness: 0.5, clippingPlanes: clip }),
      door: new T.MeshStandardMaterial({ color: 0x4f555c, roughness: 0.6, clippingPlanes: clip }),
      wood: new T.MeshStandardMaterial({ map: tex.wood, roughness: 0.85, side: T.DoubleSide }),
      hedge: new T.MeshStandardMaterial({ map: tex.hedge, roughness: 1 }),
      shedRoof: new T.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.7, side: T.DoubleSide }),
      water: new T.MeshPhongMaterial({ color: 0x1b3440, specular: 0x9fb8c8, shininess: 90, transparent: true, opacity: 0.88 }),
      post: new T.MeshStandardMaterial({ color: 0xa3a8ad, roughness: 0.7, side: T.DoubleSide }),
      canopy: new T.MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.6, transparent: true, opacity: 0.85, side: T.DoubleSide }),
    };
    const add = (geo, m, opts = {}) => {
      const mesh = new T.Mesh(geo, m);
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = true;
      scene.add(mesh);
      return mesh;
    };
    this._add = add;
    this._mat = mat;

    // ground: optional orthophoto quad over a large lawn plane
    const lawn = new T.Mesh(new T.PlaneGeometry(400, 400), new T.MeshStandardMaterial({ color: house.ortho ? 0x6b7a4c : 0x55703f, roughness: 1 }));
    lawn.rotation.x = -Math.PI / 2;
    lawn.position.set(this._center[0], -0.03, this._center[2]);
    lawn.receiveShadow = true;
    scene.add(lawn);
    if (house.ortho?.url && house.ortho.corners) {
      const [tl, tr, br, bl] = house.ortho.corners;
      // plan point -> photo UV, also used to drape the photo over berms
      const ux = [tr[0] - tl[0], tr[1] - tl[1]], vy = [bl[0] - tl[0], bl[1] - tl[1]];
      const det = ux[0] * vy[1] - ux[1] * vy[0];
      this._orthoUV = ([x, z]) => {
        const dx = x - tl[0], dz = z - tl[1];
        return [(dx * vy[1] - dz * vy[0]) / det, 1 - (ux[0] * dz - ux[1] * dx) / det];
      };
      const og = new T.BufferGeometry();
      og.setAttribute("position", new T.Float32BufferAttribute([bl, br, tr, tl].flatMap(([x, z]) => [x, 0, z]), 3));
      og.setAttribute("uv", new T.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      og.setIndex([0, 1, 2, 0, 2, 3]);
      og.computeVertexNormals();
      // the photo fades out at its edges (and outside ortho.clip) into the lawn
      // lawn coloured until the photo has loaded (or if it is missing)
      const ortho = new T.MeshStandardMaterial({ color: 0x6b7a4c, roughness: 1, transparent: true,
        alphaMap: orthoMask(T, house.ortho), depthWrite: false });
      this._orthoMats = [ortho];
      new T.TextureLoader().load(new URL(house.ortho.url, location.origin).href, (t) => {
        t.colorSpace = T.SRGBColorSpace;
        t.anisotropy = this._renderer.capabilities.getMaxAnisotropy();
        this._orthoMats.forEach((m) => { m.map = t; m.color.set(0xe2e2e2); m.needsUpdate = true; });
        this._dirty();
      });
      const m = new T.Mesh(og, ortho);
      m.renderOrder = -1;
      m.receiveShadow = true;
      scene.add(m);
    }

    if (house.shell) this._buildShell();
    (house.roofs || []).forEach((r) => (r.type === "tent" ? this._tentRoof(r) : this._gableRoof(r)));
    this._buildRooms();
    if (house.shell) this._buildWindows();
    this._buildOutdoor();
    this._buildPlants();

    this._hemi = new T.HemisphereLight(0xbfd8ff, 0x4a5a3a, 1);
    scene.add(this._hemi);
    const sun = new T.DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = this._extent();
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 300 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.target.position.set(...this._center);
    scene.add(sun, sun.target);
    this._sun = sun;
    // cool moonlight, so the house stays readable at night
    const moon = new T.DirectionalLight(0x9db4ff, 0);
    moon.position.set(this._center[0] - 40, 70, this._center[2] + 30);
    moon.target.position.set(...this._center);
    scene.add(moon, moon.target);
    this._moon = moon;
    this._resize();
    this._applyMode();
  }

  // box along a→b, thickness t, shifted by inset along the left normal
  _wall(m, a, b, h, t, y0 = 0, inset = 0) {
    const T = this._T;
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    const mesh = this._add(worldUV(new T.BoxGeometry(len, h, t)), m);
    const nx = -dz / len, nz = dx / len;
    mesh.position.set((a[0] + b[0]) / 2 + nx * inset, y0 + h / 2, (a[1] + b[1]) / 2 + nz * inset);
    mesh.rotation.y = -Math.atan2(dz, dx);
    return mesh;
  }

  _shellHeight(pt) {
    const z = (this._house.wall_zones || []).find((w) =>
      w.rect ? inRect(pt, w.rect) : Math.hypot(pt[0] - w.circle[0], pt[1] - w.circle[1]) < w.circle[2]);
    return z ? z.height : this._house.wall_height || 3;
  }

  _buildShell() {
    // outer walls, 36 cm, inset towards the inside of the outline
    const shell = this._house.shell, dir = Math.sign(signedArea(shell));
    shell.forEach((a, i) => {
      const b = shell[(i + 1) % shell.length];
      this._wall(this._mat.brick, a, b, this._shellHeight([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), 0.36, 0, 0.18 * dir);
    });
  }

  // gable roof over wall rectangle r.rect; ridge along z unless axis is "x"
  _roofFrame(r) {
    const [x0, z0, x1, z1] = r.rect;
    const alongX = r.axis === "x";
    // u = across the ridge, v = along it
    const [u0, u1, v0, v1] = alongX ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
    const um = (u0 + u1) / 2, slope = (r.ridge - r.eave) / (um - u0);
    const P = (u, y, v) => (alongX ? [v, y, u] : [u, y, v]);
    return { u0, u1, v0, v1, um, slope, P, yAt: (u) => r.ridge - Math.abs(u - um) * slope };
  }

  _gableRoof(r) {
    const T = this._T, o = r.overhang ?? 0.5;
    const { u0, u1, v0, v1, um, P, yAt } = this._roofFrame(r);
    const quad = (pts) => {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(pts.flat(), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      // UV: along the ridge and down the slope, in metres
      g.setAttribute("uv", new T.Float32BufferAttribute(pts.flatMap(([x, y, z]) => {
        const [u, v] = r.axis === "x" ? [z, x] : [x, z];
        return [v, Math.hypot(u - um, y - r.ridge)];
      }), 2));
      return this._add(g, this._mat.roof);
    };
    const a = u0 - o, b = u1 + o, va = v0 - o, vb = v1 + o;
    quad([P(a, yAt(a), va), P(um, r.ridge, va), P(um, r.ridge, vb), P(a, yAt(a), vb)]);
    quad([P(um, r.ridge, va), P(b, yAt(b), va), P(b, yAt(b), vb), P(um, r.ridge, vb)]);
    if (r.open) {
      // open gable (carport, terrace roof): verge boards instead of brick, roof on posts
      [va, vb].forEach((v) => [a, b].forEach((u) => {
        const g = new T.BufferGeometry();
        g.setAttribute("position", new T.Float32BufferAttribute([...P(u, yAt(u), v), ...P(um, r.ridge, v),
          ...P(um, r.ridge - 0.22, v), ...P(u, yAt(u) - 0.22, v)], 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.computeVertexNormals();
        this._add(g, this._mat.post);
      }));
      [v0, v1].forEach((v) => {
        const beam = (p0, p1) => {
          const g = new T.BufferGeometry();
          const d = 0.08;
          g.setAttribute("position", new T.Float32BufferAttribute([...p0, ...p1,
            ...[p1[0], p1[1] - d, p1[2]], ...[p0[0], p0[1] - d, p0[2]]], 3));
          g.setIndex([0, 1, 2, 0, 2, 3]);
          g.computeVertexNormals();
          this._add(g, this._mat.post);
        };
        beam(P(u0, r.eave, v), P(u1, r.eave, v));                       // tie beam
        const ky = r.eave;                                                 // king post
        const g = new T.BoxGeometry(0.12, r.ridge - ky, 0.12);
        this._add(g, this._mat.post).position.set(...P(um, (r.ridge + ky) / 2, v));
      });
      (r.posts || []).forEach(([x, z]) => {
        const h = yAt(r.axis === "x" ? z : x);
        this._add(new T.BoxGeometry(0.14, h, 0.14), this._mat.post).position.set(x, h / 2, z);
      });
      return;
    }
    // gable triangles at both wall lines
    [v0, v1].forEach((v) => {
      const g = new T.BufferGeometry();
      g.setAttribute("position", new T.Float32BufferAttribute(
        [...P(u0, r.eave, v), ...P(u1, r.eave, v), ...P(um, r.ridge - 0.05, v)], 3));
      g.computeVertexNormals();
      this._add(worldUV(g), this._mat.brick);
    });
  }

  _tentRoof(r) {
    const T = this._T, [cx, cz] = r.center, o = r.overhang ?? 0.5;
    const base = r.ring.map(([x, z]) => {
      const d = Math.hypot(x - cx, z - cz), k = (d + o) / d;
      return [cx + (x - cx) * k, r.base, cz + (z - cz) * k];
    });
    const pos = [];
    base.forEach((p, i) => pos.push(...p, ...base[(i + 1) % base.length], cx, r.apex, cz));
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const uv = [];
    for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] + pos[i + 2] * 0.3, pos[i + 1] * 1.4);
    g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    this._add(g, this._mat.roof);
  }

  // underside height of the roofs above a plan point; where roofs overlap
  // (cross gables) the higher one is the ceiling
  _roofY(pt) {
    let y = -Infinity;
    (this._house.roofs || []).forEach((r) => {
      if (r.type === "tent") {
        const [cx, cz] = r.center, o = r.overhang ?? 0.5;
        const ring = r.ring.map(([x, z]) => {
          const d = Math.hypot(x - cx, z - cz), k = (d + o) / d;
          return [cx + (x - cx) * k, cz + (z - cz) * k];
        });
        const px = pt[0] - cx, pz = pt[1] - cz;
        ring.forEach((b, i) => {
          const c = ring[(i + 1) % ring.length];
          const bx = b[0] - cx, bz = b[1] - cz, qx = c[0] - cx, qz = c[1] - cz;
          // barycentric weights of the point in triangle (apex, b, c)
          const det = bx * qz - bz * qx;
          const wb = (px * qz - pz * qx) / det, wc = (bx * pz - bz * px) / det;
          if (wb >= -1e-6 && wc >= -1e-6 && wb + wc <= 1 + 1e-6) y = Math.max(y, r.apex - (r.apex - r.base) * (wb + wc));
        });
      } else if (inRect(pt, [0, 1, 2, 3].map((i) => r.rect[i] + (i < 2 ? -1 : 1) * (r.overhang ?? 0.5)))) {
        const f = this._roofFrame(r);
        y = Math.max(y, f.yAt(r.axis === "x" ? pt[1] : pt[0]));
      }
    });
    return y === -Infinity ? Infinity : y;
  }

  _buildRooms() {
    const T = this._T;
    this._house.rooms.forEach((r) => {
      const f = r.floor || 0, y = this._floors()[f]?.level || 0;
      // floor: a thin slab, upper floor slabs carry the visual ceiling
      const thick = f ? 0.22 : 0.04;
      const geo = new T.ExtrudeGeometry(new T.Shape(r.p.map(([x, z]) => new T.Vector2(x, z))), { depth: thick, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      geo.translate(0, y + 0.02, 0);
      const fm = this._mat.floor.clone();
      fm.clippingPlanes = [this._clip];     // clone() copies the plane, keep it shared
      const floor = this._add(geo, fm, { cast: !!f });
      floor.userData.room = r.id;
      // interior partitions, 12 cm, just outside each room edge; upper floors stop below the roof
      const dir = Math.sign(signedArea(r.p));
      r.p.forEach((a, i) => {
        const b = r.p[(i + 1) % r.p.length];
        const wh = f ? Math.min(2.3, Math.min(this._roofY(a), this._roofY(b)) - y - 0.25) : 2.75;
        if (wh > 0.2) this._wall(this._mat.inner, a, b, wh, 0.12, y, -0.06 * dir);
      });
      const cfg = this._room(r.id);
      const [cx, cz] = centroid(r.p);
      // one point light per room that has lamps configured
      let light = null;
      if (cfg.lights?.length) {
        light = new T.PointLight(0xffc27a, 0, 9, 2);
        light.position.set(cx, y + 2.1, cz);
        this._scene.add(light);
      }
      this._rooms[r.id] = { r, cfg, floor, light, windows: [], c: [cx, y + 1.2, cz], f };
    });
  }

  _roomAt(pt, f) {
    return this._house.rooms.find((g) => (g.floor || 0) === f && inside(pt, g.p));
  }

  _buildWindows() {
    // windows along the shell; each pane glows with its room's light
    const T = this._T, mat = this._mat, shell = this._house.shell;
    const dir = Math.sign(signedArea(shell));
    const upper = this._floors()[1]?.level;
    const face = (m, cx, y, cz, nx, nz, off) => {
      m.position.set(cx + nx * off, y, cz + nz * off);
      m.rotation.y = Math.atan2(nx, nz);
      return m;
    };
    const pane = (id, w, h, cx, y, cz, nx, nz) => {
      face(this._add(new T.PlaneGeometry(w + 0.12, h + 0.12), mat.frame, { cast: false }), cx, y, cz, nx, nz, 0.01);
      const glass = new T.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.15, metalness: 0.4, clippingPlanes: [this._clip] });
      const g = face(this._add(new T.PlaneGeometry(w, h), glass, { cast: false }), cx, y, cz, nx, nz, 0.02);
      g.userData.room = id;
      this._rooms[id]?.windows.push(glass);
    };
    // triangular pane with its apex at (cx, top, cz): gable windows and pointed arches
    const triPane = (id, w, h, top, cx, cz, nx, nz) => {
      const tri = (tw, th, m, off) => {
        const g = new T.BufferGeometry();
        g.setAttribute("position", new T.Float32BufferAttribute([-tw / 2, -th, 0, tw / 2, -th, 0, 0, 0, 0], 3));
        g.computeVertexNormals();
        return face(this._add(g, m, { cast: false }), cx, top, cz, nx, nz, off);
      };
      tri(w + 0.2, h + 0.1, mat.frame, 0.01).material.side = T.DoubleSide;
      const glass = new T.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.15, metalness: 0.4, side: T.DoubleSide,
        clippingPlanes: [this._clip] });
      tri(w, h, glass, 0.02).userData.room = id;
      this._rooms[id]?.windows.push(glass);
    };
    const doors = this._house.doors || [], fixed = this._house.windows || [];
    shell.forEach((a, i) => {
      const b = shell[(i + 1) % shell.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 0.9) return;
      const nx = (dz / len) * dir, nz = (-dx / len) * dir;     // outward normal
      // doors sitting on this edge, and window positions that keep clear of them
      const along = (p) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len;
      const off = (p) => Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * nz);
      const here = doors.filter((d) => off(d.at) < 0.3 && along(d.at) > -0.1 && along(d.at) < len + 0.1);
      here.forEach((d) => {
        face(this._add(new T.PlaneGeometry(d.width || 1.1, d.height || 2.15), mat.door, { cast: false }),
          d.at[0], (d.sill || 0) + (d.height || 2.15) / 2, d.at[1], nx, nz, 0.02);
      });
      // windows given in house.windows replace the automatic ones of their floor on this wall
      const mine = fixed.filter((w) => off(w.at) < 0.3 && along(w.at) > -0.1 && along(w.at) < len + 0.1);
      mine.filter((w) => !w.none).forEach((w) => {
        const f = w.floor || 0, h = w.height || 1.3, level = this._floors()[f]?.level || 0;
        const room = this._roomAt([w.at[0] - nx * 0.7, w.at[1] - nz * 0.7], f);
        const ww = w.width || 1.1, top = level + (w.sill ?? 0.85) + h;
        pane(room?.id ?? null, ww, h, w.at[0], top - h / 2, w.at[1], nx, nz);
        // pointed (church) window: a triangle on top of the rectangle
        if (w.shape === "pointed") triPane(room?.id ?? null, ww, ww * 0.55, top + ww * 0.55, w.at[0], w.at[1], nx, nz);
      });
      const auto = (f) => !mine.some((w) => (w.floor || 0) === f);
      const n = !auto(0) ? 0 : len > 7 ? Math.floor(len / 2.6) : len > 2.6 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const s = (k + 0.5) / n, cx = a[0] + dx * s, cz = a[1] + dz * s;
        if (here.some((d) => Math.abs(along(d.at) - s * len) < (d.width || 1.1) / 2 + 0.4)) continue;
        const room = this._roomAt([cx - nx * 0.7, cz - nz * 0.7], 0);
        if (!room || room.window === "none") continue;
        if (room.window === "small") pane(room.id, 0.5, 0.9, cx, 1.6, cz, nx, nz);
        else if (len < 1.6) pane(room.id, 0.7, 1.9, cx, 1.3, cz, nx, nz);     // narrow facets: tall windows
        else pane(room.id, 1.1, 1.3, cx, 1.5, cz, nx, nz);
      }
      // upper floor: windows in the gables of roofs marked with windows: true
      if (upper === undefined) return;
      (this._house.roofs || []).filter((r) => r.windows && r.type !== "tent").forEach((r) => {
        const f = this._roofFrame(r);
        const ends = r.axis === "x" ? [a[0], b[0]] : [a[1], b[1]];
        const gable = [f.v0, f.v1].find((v) => Math.abs(ends[0] - v) < 0.05 && Math.abs(ends[1] - v) < 0.05);
        if (gable === undefined) return;
        if (r.windows !== "attic" && auto(1)) for (const s of [0.28, 0.72]) {
          const cx = a[0] + dx * s, cz = a[1] + dz * s;
          const room = this._roomAt([cx - nx * 0.7, cz - nz * 0.7], 1);
          if (room) pane(room.id, 0.95, 1.25, cx, upper + 1.55, cz, nx, nz);
        }
        const [mx, mz] = r.axis === "x" ? [gable, f.um] : [f.um, gable];
        triPane(null, 1.1, 0.52, r.ridge - 0.55, mx, mz, nx, nz);
      });
    });
    // dormers: roofs with windows: glazed get a triangular window filling each gable
    (this._house.roofs || []).filter((r) => r.windows === "glazed" && r.type !== "tent").forEach((r) => {
      const f = this._roofFrame(r), w = (f.u1 - f.u0) * 0.8, h = (r.ridge - r.eave) * 0.8;
      [[f.v0, -1], [f.v1, 1]].forEach(([v, sgn]) => {
        const [cx, cz] = r.axis === "x" ? [v, f.um] : [f.um, v];
        const [nx, nz] = r.axis === "x" ? [sgn, 0] : [0, sgn];
        const room = this._roomAt([cx - nx * 0.7, cz - nz * 0.7], 1);
        triPane(room?.id ?? null, w, h, r.ridge - 0.12, cx, cz, nx, nz);
      });
    });
    // roof windows: lie in the roof plane above w.at, glow with the room below
    (this._house.roof_windows || []).forEach((w) => {
      const [x, z] = w.at, e = 0.25, y = this._roofY(w.at);
      if (!Number.isFinite(y)) return;
      const gx = (this._roofY([x + e, z]) - this._roofY([x - e, z])) / (2 * e);
      const gz = (this._roofY([x, z + e]) - this._roofY([x, z - e])) / (2 * e);
      const n = new T.Vector3(-gx, 1, -gz).normalize();
      const up = new T.Vector3(gx, gx * gx + gz * gz, gz).normalize();
      const right = new T.Vector3().crossVectors(up, n);
      const basis = new T.Matrix4().makeBasis(right, up, n);
      const room = this._roomAt(w.at, w.floor ?? 1);
      const put = (geo, m, off) => {
        const mesh = this._add(geo, m, { cast: false });
        mesh.quaternion.setFromRotationMatrix(basis);
        mesh.position.set(x, y, z).addScaledVector(n, off);
        return mesh;
      };
      const ww = w.width || 0.8, hh = w.height || 1.0;
      put(new T.PlaneGeometry(ww + 0.12, hh + 0.12), mat.frame, 0.04);
      const glass = new T.MeshStandardMaterial({ color: 0x1c2733, roughness: 0.1, metalness: 0.5, clippingPlanes: [this._clip] });
      put(new T.PlaneGeometry(ww, hh), glass, 0.05).userData.room = room?.id;
      if (room) this._rooms[room.id]?.windows.push(glass);
    });
  }

  // half size of the area that receives sun shadows: house, zones and plants
  _extent() {
    const [cx, , cz] = this._center;
    const pts = [...(this._house.shell || []), ...this._zones().flatMap((z) => outline(z)),
      ...(this._house.plants || []).map((p) => p.at)];
    const d = Math.max(0, ...pts.map(([x, y]) => Math.max(Math.abs(x - cx), Math.abs(y - cz))));
    return Math.max(32, Math.min(70, d + 4));
  }

  // trees, conifers and shrubs as instanced meshes
  _buildPlants() {
    const T = this._T, plants = this._house.plants || [];
    if (!plants.length) return;
    const rnd = seeded(7);
    const foliage = canvasTex(T, 256, PAINT.foliage, 1);
    foliage.repeat.set(6, 3);
    const leaves = new T.MeshStandardMaterial({ map: foliage, roughness: 0.95 });
    const bark = new T.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 });
    const tint = { tree: "#4f6e3b", conifer: "#2e4a31", shrub: "#58763f" };
    const count = (k) => plants.filter((p) => (p.kind || "tree") === k).length;
    // big trees get two side lobes, so crowns are not plain balls
    const crowns = new T.InstancedMesh(crownGeometry(T), leaves, count("tree") * 3 + count("shrub"));
    const cones = new T.InstancedMesh(new T.ConeGeometry(1, 1, 10), leaves, Math.max(1, count("conifer")));
    const trunks = new T.InstancedMesh(new T.CylinderGeometry(0.7, 1, 1, 6), bark, Math.max(1, count("tree") + count("conifer")));
    const m = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), col = new T.Color();
    const n = { crown: 0, cone: 0, trunk: 0 };
    const put = (mesh, key, x, y, z, sx, sy, sz, c) => {
      q.setFromAxisAngle(up, rnd() * 6.283);
      m.compose(new T.Vector3(x, y, z), q, new T.Vector3(sx, sy, sz));
      mesh.setMatrixAt(n[key], m);
      if (c) mesh.setColorAt(n[key], c);
      n[key]++;
    };
    plants.forEach((p) => {
      const kind = p.kind || "tree", [x, z] = p.at, r = p.r || 1.5, gy = this._groundY(p.at);
      const j = 0.9 + 0.2 * rnd();
      col.set(p.color || tint[kind] || tint.tree).offsetHSL(0, 0, (rnd() - 0.5) * 0.06);
      if (kind === "shrub") {
        const h = p.h || r * 1.4;
        put(crowns, "crown", x, gy + h / 2 - 0.05, z, r * j, h / 2, r * j, col);
      } else if (kind === "conifer") {
        const h = p.h || r * 4;
        put(cones, "cone", x, gy + h * 0.12 + h * 0.44, z, r, h * 0.88, r, col);
        put(trunks, "trunk", x, gy + h * 0.075, z, 0.12, h * 0.15, 0.12);
      } else {
        const h = p.h || r * 2.4 + 2.5, cy = Math.max(Math.min(r * 1.1, h * 0.45), h * 0.36), stem = h - cy;
        put(crowns, "crown", x, gy + h - cy, z, r * j, cy, r * (2 - j), col);
        if (r > 2.2) for (let k = 0; k < 2; k++) {
          const a = rnd() * 6.283, d = r * 0.45;
          put(crowns, "crown", x + Math.cos(a) * d, gy + h - cy * (1.25 + 0.2 * rnd()), z + Math.sin(a) * d,
            r * 0.62, cy * 0.62, r * 0.62, col.clone().offsetHSL(0, 0, (rnd() - 0.5) * 0.05));
        }
        put(trunks, "trunk", x, gy + stem / 2, z, 0.06 * r + 0.08, stem, 0.06 * r + 0.08);
      }
    });
    [crowns, cones, trunks].forEach((mesh, i) => {
      mesh.count = [n.crown, n.cone, n.trunk][i];
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this._scene.add(mesh);
    });
  }

  // earth wall along z.line with a trapezoid cross-section, draped with the aerial photo
  _buildBerm(z) {
    const T = this._T, h = z.height || 2, top = (z.width ?? 2) / 2, base = (z.base || 8) / 2;
    // the ends run out with the same slope as the sides
    const ramp = (pa, pb) => {
      const l = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) || 1, k = (base - top) / l;
      return [pb[0] + (pb[0] - pa[0]) * k, pb[1] + (pb[1] - pa[1]) * k];
    };
    const line = [ramp(z.line[1], z.line[0]), ...z.line, ramp(z.line.at(-2), z.line.at(-1))];
    const n = lineNormals(line);
    const pos = [], idx = [];
    line.forEach((c, i) => {
      const end = i === 0 || i === line.length - 1;
      [[-base, 0], [-top, h], [top, h], [base, 0]].forEach(([o, y]) => {
        const oo = end ? Math.sign(o) * Math.min(Math.abs(o), top) : o;
        pos.push(c[0] + n[i][0] * oo, end ? 0 : y, c[1] + n[i][1] * oo);
      });
    });
    for (let i = 0; i < line.length - 1; i++) for (let k = 0; k < 3; k++) {
      const a = i * 4 + k, b = a + 4;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    let m;
    if (this._orthoUV) {
      const uv = [];
      for (let i = 0; i < pos.length; i += 3) uv.push(...this._orthoUV([pos[i], pos[i + 2]]));
      g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
      const o = this._orthoMats[0];
      m = new T.MeshStandardMaterial({ color: o.color.clone(), map: o.map, roughness: 1, side: T.DoubleSide,
        transparent: true, alphaTest: 0.02, alphaMap: o.alphaMap });
      this._orthoMats.push(m);
    } else {
      worldUV(g);
      m = new T.MeshStandardMaterial({ color: 0x5f7a45, roughness: 1, side: T.DoubleSide });
    }
    this._add(g, m).userData.room = z.id;
  }

  // ground height under a plan point: berms lift it
  _groundY(pt) {
    let y = 0;
    this._zones().forEach((z) => {
      if (z.kind !== "berm" || !z.line) return;
      const d = lineDist(pt, z.line), h = z.height || 2, top = (z.width ?? 2) / 2, base = (z.base || 8) / 2;
      if (d < base) y = Math.max(y, d <= top ? h : h * (base - d) / (base - top));
    });
    return y;
  }

  _buildOutdoor() {
    const T = this._T, mat = this._mat;
    this._zoneLights = [];
    this._zones().forEach((z) => {
      const kind = z.kind || "paved";
      const p = outline(z);
      const shape = new T.Shape(p.map(([x, y]) => new T.Vector2(x, y)));
      const extrude = (depth, y0, m) => {
        const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        g.rotateX(Math.PI / 2);
        g.translate(0, y0 + depth, 0);
        worldUV(g);
        const mesh = this._add(g, m);
        mesh.userData.room = z.id;
        return mesh;
      };
      if (kind === "berm") {
        if (z.line?.length > 1) this._buildBerm(z);
      } else if (kind === "water") {
        extrude(0.02, 0.03, mat.water).castShadow = false;
      } else if (kind === "hedge") {
        extrude(z.height || 1.6, 0, mat.hedge);
      } else if (kind === "deck") {
        extrude(0.12, 0.25, mat.wood);
        if (z.roof) extrude(0.08, z.roof, mat.shedRoof);
      } else if (kind === "building") {
        // garden house: walls and a saddle roof along its long side; with porch: <deck zone id>
        // the roof runs on over that deck and rests on posts at its far end
        const h = z.height || 2.3, brick = z.walls === "brick";
        extrude(h, 0, brick ? mat.brick : mat.wood);
        const edges = p.map((a, i) => [a, p[(i + 1) % p.length]]);
        const elen = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
        const e = [...edges].sort((u, v) => elen(v) - elen(u))[0];
        const ang = Math.atan2(e[1][1] - e[0][1], e[1][0] - e[0][0]), ex = Math.cos(ang), ez = Math.sin(ang);
        const al = ([x, y]) => x * ex + y * ez, ac = ([x, y]) => y * ex - x * ez;
        const porch = z.porch && this._zones().find((q) => q.id === z.porch);
        const pp = porch ? outline(porch) : [];
        const span = (pts, f) => [Math.min(...pts.map(f)), Math.max(...pts.map(f))];
        const [b0, b1] = span(p, al), [c0, c1] = span(p, ac), [r0, r1] = span([...p, ...pp], al);
        const len = r1 - r0 + 0.6, w = c1 - c0, wid = w + 0.6, rise = (wid / 2) * Math.tan(0.4);
        const am = (r0 + r1) / 2, cm = (c0 + c1) / 2;
        const roofMat = brick ? mat.roof : mat.shedRoof;
        const roof = new T.Group();
        [-1, 1].forEach((s) => {
          const g = new T.PlaneGeometry(len, Math.hypot(wid / 2, rise));
          const uv = g.attributes.uv;
          for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * Math.hypot(wid / 2, rise));
          const pl = new T.Mesh(g, roofMat);
          pl.rotation.x = -Math.PI / 2 + s * 0.4;
          pl.position.set(0, rise / 2, s * wid / 4);
          pl.castShadow = pl.receiveShadow = true;
          roof.add(pl);
        });
        // gable triangles at the house's own ends, in the wall material
        [b0, b1].forEach((a) => {
          const g = new T.BufferGeometry();
          g.setAttribute("position", new T.Float32BufferAttribute([a - am, 0, -w / 2, a - am, 0, w / 2, a - am, rise * w / wid, 0], 3));
          g.computeVertexNormals();
          const m = new T.Mesh(worldUV(g), new T.MeshStandardMaterial({ map: (brick ? mat.brick : mat.wood).map, side: T.DoubleSide }));
          m.castShadow = m.receiveShadow = true;
          roof.add(m);
        });
        roof.position.set(am * ex - cm * ez, h, am * ez + cm * ex);
        roof.rotation.y = -ang;
        this._scene.add(roof);
        if (porch) {
          // posts at the porch corners furthest from the house
          const far = Math.abs(r0 - b0) > Math.abs(r1 - b1) ? r0 : r1;
          pp.filter((q) => Math.abs(al(q) - far) < 0.4).forEach(([x, y]) => {
            const base = 0.37, q = [x - (far === r0 ? -0.25 : 0.25) * ex, y - (far === r0 ? -0.25 : 0.25) * ez];
            const pm = this._add(new T.BoxGeometry(0.14, h - base, 0.14), mat.post);
            pm.position.set(q[0], base + (h - base) / 2, q[1]);
          });
        }
      } else if (z.roof) {
        // covered terrace: a canopy on slim posts
        extrude(0.1, z.roof, mat.canopy);
        p.forEach(([x, y]) => {
          this._add(new T.BoxGeometry(0.12, z.roof, 0.12), mat.frame).position.set(x, z.roof / 2, y);
        });
      }
      if (z.lights?.length) {
        const [cx, cz] = Array.isArray(z.label) ? z.label : centroid(p);
        const l = new T.PointLight(0xffc27a, 0, 10, 2);
        l.position.set(cx, (z.roof || 2.4) - 0.2, cz);
        this._scene.add(l);
        this._zoneLights.push({ z, l });
      }
    });
  }

  // ---------- state ----------
  _applyMode() {
    this.shadowRoot.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === this._mode));
    if (!this._scene) return;
    this._clip.constant = this._clipFor(this._mode);
    this._update();
  }

  _update() {
    if (!this._scene) return;
    const T = this._T, st = this._hass.states;
    // sun from sun.sun; the plan axes are turned by house.north against true north
    const sun = st["sun.sun"]?.attributes || {};
    const elev = sun.elevation ?? 35;
    const el = elev * Math.PI / 180, az = (sun.azimuth ?? 180) * Math.PI / 180;
    // house.north: compass bearing of the plan's "up" direction (0 = plan drawn north up)
    const E = Math.sin(az) * Math.cos(el), N = Math.cos(az) * Math.cos(el);
    const b = (this._house.north || 0) * Math.PI / 180;
    const right = E * Math.cos(b) - N * Math.sin(b), up = E * Math.sin(b) + N * Math.cos(b);
    const v = new T.Vector3(right, Math.max(0.08, Math.sin(el)), -up);
    const day = Math.max(0, Math.min(1, elev / 12 + 0.3)), night = 1 - day;
    this._sun.position.copy(v.normalize().multiplyScalar(140)).add(new T.Vector3(...this._center));
    this._sun.intensity = 3.2 * day;
    this._sun.color.setHSL(0.09, 0.5 * night + 0.1, 0.9);
    this._moon.intensity = 1.1 * night;
    this._hemi.intensity = 0.8 + 1.0 * day;
    this._hemi.color.lerpColors(new T.Color(0x8ea8dc), new T.Color(0xbfd8ff), day);
    const sky = new T.Color().lerpColors(new T.Color(0x1a2644), new T.Color(0xa9cbea), day);
    this._scene.background = sky;
    this._scene.fog = new T.Fog(sky, 90, 260);
    let lit = 0;
    Object.values(this._rooms).forEach((room) => {
      const s = lightState(this._hass, room.cfg.lights);
      const col = s ? new T.Color(`rgb(${s.rgb})`) : null;
      if (room.light) {
        // without shadows a room light would also light the roof from inside,
        // so in the outside view only the windows glow
        room.light.intensity = s && this._mode !== "house" ? (6 + 18 * night) * s.bri : 0;
        if (col) room.light.color.copy(col);
      }
      room.windows.forEach((g) => {
        g.emissive.set(col || 0x000000);
        g.emissiveIntensity = s ? 0.25 + 0.85 * night * s.bri : 0;
      });
      room.floor.material.emissive.set(col || 0x000000);
      room.floor.material.emissiveIntensity = s && this._mode !== "house" ? 0.18 * s.bri : 0;
      if (s) lit++;
      room.state = s;
    });
    this._zoneLights.forEach(({ z, l }) => {
      const s = lightState(this._hass, z.lights);
      l.intensity = s ? (4 + 16 * night) * s.bri : 0;
      if (s) l.color.set(`rgb(${s.rgb})`);
    });
    this.shadowRoot.querySelector(".sum").textContent =
      lit ? `Licht in ${lit} ${lit === 1 ? "Raum" : "Räumen"}` : "Alle Lichter aus";
    this._renderLabels();
    this._dirty();
  }

  _renderLabels() {
    this._labels.innerHTML = "";
    this._chips = [];
    if (this._mode === "house") return;
    const f = +this._mode, st = this._hass.states;
    Object.values(this._rooms).forEach((room) => {
      if (room.f !== f || !this._config.rooms[room.r.id]) return;
      const cfg = room.cfg;
      const t = cfg.temperature && parseFloat(st[cfg.temperature]?.state);
      const el = document.createElement("div");
      el.className = "chip";
      el.innerHTML = `<span>${this._name(room.r.id)}</span>` +
        (Number.isFinite(t) ? `<span class="t">${t.toLocaleString("de-DE", { maximumFractionDigits: 1 })}°</span>` : "") +
        (room.state ? `<ha-icon icon="mdi:lightbulb-on"></ha-icon>` : "");
      this._labels.appendChild(el);
      this._chips.push({ el, p: new this._T.Vector3(...room.c) });
    });
  }

  _placeLabels() {
    const { width, height } = this._stage.getBoundingClientRect();
    (this._chips || []).forEach(({ el, p }) => {
      const v = p.clone().project(this._camera);
      el.style.left = ((v.x + 1) / 2) * width + "px";
      el.style.top = ((1 - v.y) / 2) * height + "px";
      el.style.display = v.z < 1 ? "" : "none";
    });
  }

  // first visible surface below the cut decides; walls and roofs block
  _pick(x, y) {
    if (!this._scene) return null;
    const rect = this._stage.getBoundingClientRect();
    const ray = new this._T.Raycaster();
    ray.setFromCamera(new this._T.Vector2(((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1), this._camera);
    const cut = this._clip.constant;
    const hit = ray.intersectObjects(this._scene.children, true).find((h) => h.point.y < cut);
    const id = hit?.object.userData.room;
    if (!id) return null;
    return this._mode === "house" || !this._rooms[id] || this._rooms[id].f === +this._mode ? id : null;
  }
}

// =====================================================================
// The card: hosts one renderer and switches between them
// =====================================================================
class House3DCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: "Haus 3D",
      house: { rooms: [{ id: "wohnen", name: "Wohnen", p: [[0, 0], [6, 0], [6, 5], [0, 5]] },
        { id: "kueche", name: "Küche", p: [[6.2, 0], [10, 0], [10, 5], [6.2, 5]] }] },
      rooms: {},
    };
  }

  setConfig(config) {
    if (!config.house?.rooms) throw new Error("house.rooms fehlt");
    this._config = config;
    try {
      this._style = localStorage.getItem(this._key()) || this._style;
    } catch (e) {
      // storage blocked: fall back to the configured style
    }
    this._style = this._style || config.style || "schematic";
    this._mount();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._child) this._child.hass = hass;
  }

  getCardSize() {
    return 9;
  }

  getGridOptions() {
    return { columns: 12, rows: 9, min_columns: 6 };
  }

  _key() {
    return `house-3d-card:${this._config.title || "default"}:style`;
  }

  _mount() {
    const tag = this._style === "realistic" ? "house-3d-real" : "house-3d-schematic";
    if (this._child?.localName !== tag) {
      this._child?._dispose?.();
      this._child?.remove();
      this._child = document.createElement(tag);
      this._child.addEventListener("house-3d-style", (e) => {
        this._style = e.detail;
        try {
          localStorage.setItem(this._key(), this._style);
        } catch (err) {
          // not persisted; the switch still applies to this page view
        }
        this._mount();
      });
      this.style.display = "block";
      this.appendChild(this._child);
    }
    this._child.setConfig(this._config);
    if (this._hass) this._child.hass = this._hass;
  }
}

if (!customElements.get("house-3d-card")) {
  customElements.define("house-3d-schematic", HouseSchematic);
  customElements.define("house-3d-real", HouseReal);
  customElements.define("house-3d-card", House3DCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "house-3d-card",
    name: "House 3D Card",
    description: "Interaktives 3D-Modell des Hauses: schematisch oder realistisch mit Sonnenstand und Licht",
    preview: false,
  });
  console.info(`%c HOUSE-3D-CARD %c ${VERSION} `, "background:#5a4448;color:#fff", "");
}
