/**
 * controls.js — the control rail, shared by every view (spec section 6).
 *
 *   config   one configuration
 *   n_modes  multi-select, overplots
 *   t_start  live slider, in M_rem, origin at the IMR max-likelihood peak GPS
 *   pinned   colour-coded compare set; pinning freezes the current selection
 *   params   panel subset
 *   level    credible level in percent
 *
 * Ruling 2: the slider fires on `input`, not on `change`, so the plot changes
 * DURING the drag. Ruling 3: overplot works across start times, mode counts and
 * configurations, NOT across events — so the event is a SELECTOR, one at a
 * time, and never a multi-select like `n_modes`.
 */

import {
  AMPPHASE_AXES,
  CREDIBLE_LEVELS,
  EVENTS,
  KERR_BLOB_MODE_LABELS,
  MODEASSIGN_AXES,
  PARAM_KEYS,
  SMOOTH_SIGMAS,
  VIEW_KEYS,
  getParam,
  getView,
} from "./config.js";
import { pinColor } from "./colors.js";
import { ampPhaseMode, freezeDrawnWindows, kerrLabelsOf, levelsOf, runKey } from "./state.js";

export class ControlRail {
  /**
   * @param {HTMLElement} root
   * @param {import("./state.js").Store} store
   * @param {import("./loader.js").Loader} loader
   */
  constructor(root, store, loader) {
    this.root = root;
    this.store = store;
    this.loader = loader;
    this.build();
    store.subscribe(() => this.sync());
  }

  build() {
    const st = this.store.state;
    this.root.innerHTML = "";

    this.root.appendChild(this._row("event", this._eventSelect()));
    this.root.appendChild(this._row("config", this._configSelect()));
    this.root.appendChild(this._row("view", this._viewSelect()));
    this.root.appendChild(this._row("n_modes", (this.nBox = document.createElement("div"))));
    this.root.appendChild(this._row("t_start [M_rem]", (this.tBox = document.createElement("div"))));
    this.root.appendChild(this._row("pinned", (this.pinBox = document.createElement("div"))));
    this.root.appendChild(this._row("params", (this.pBox = document.createElement("div"))));
    this.root.appendChild(this._row("level [%]", (this.levBox = document.createElement("div"))));
    this.root.appendChild(this._row("smoothing [bins]", (this.sigBox = document.createElement("div"))));
    this.root.appendChild(this._row("scatter", (this.scBox = document.createElement("div"))));
    this.root.appendChild(this._row("prior", (this.prBox = document.createElement("div"))));
    // THREE VIEW-SPECIFIC rows. They are built once and hidden by `sync()` on
    // every view but their own: rebuilding the rail on a view change would
    // drop the slider's focus mid-drag.
    this.kmRow = this._row("Kerr blobs", (this.kmBox = document.createElement("div")));
    this.root.appendChild(this.kmRow);
    this.maRow = this._row("assignment", (this.maBox = document.createElement("div")));
    this.root.appendChild(this.maRow);
    this.apRow = this._row("amp/phase", (this.apBox = document.createElement("div")));
    this.root.appendChild(this.apRow);

    this._buildModeCounts();
    this._buildSlider();
    this._buildParams();
    this._buildLevels();
    this._buildSmooth();
    this._buildScatter();
    this._buildKerrLabels();
    this._maAxesKey = null;
    this._apAxesKey = null;
    this.sync();
    void st;
  }

  _row(label, el) {
    const d = document.createElement("div");
    d.className = "rail-row";
    const l = document.createElement("label");
    l.textContent = label;
    d.appendChild(l);
    d.appendChild(el);
    return d;
  }

  /**
   * The event selector: the first control, labelled with the site key itself.
   *
   * It only writes `ev` into the state. Reloading the payload is `main.js`'s
   * `applyEvent`, which the store subscription drives — so the selector, a
   * hand-edited hash and the back button all take the SAME path.
   */
  _eventSelect() {
    const sel = (this.evSel = document.createElement("select"));
    // A STABLE selector for the gate scripts. They used to address the rail's
    // selects by position (`#rail select >> nth=1`), which the event selector,
    // now the first control, silently shifted.
    sel.dataset.control = "event";
    for (const e of EVENTS) {
      const o = document.createElement("option");
      o.value = e;
      o.textContent = e;
      sel.appendChild(o);
    }
    sel.value = this.store.state.ev;
    sel.addEventListener("change", () => this.store.set({ ev: sel.value }));
    return sel;
  }

  _configSelect() {
    const sel = (this.cfgSel = document.createElement("select"));
    sel.dataset.control = "config";
    for (const c of this.loader.configs()) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    }
    sel.value = this.store.state.cfg;
    sel.addEventListener("change", () => {
      const cfg = sel.value;
      // Clamp n and t into what the new configuration actually has.
      const ns = this.loader.modeCounts(cfg);
      const n = this.store.state.n.filter((x) => ns.includes(x));
      const nUse = n.length ? n : [ns[0]];
      const ts = this.loader.startTimes(cfg, nUse[0]);
      const t = this.store.state.t.filter((x) => ts.includes(x));
      this.store.set({ cfg, n: nUse, t: t.length ? t : [ts[0]] });
      this._buildModeCounts();
      this._buildSlider();
    });
    return sel;
  }

  _viewSelect() {
    const sel = (this.viewSel = document.createElement("select"));
    sel.dataset.control = "view";
    for (const v of VIEW_KEYS) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = getView(v).label;
      sel.appendChild(o);
    }
    sel.value = this.store.state.view;
    sel.addEventListener("change", () => this.store.set({ view: sel.value }));
    return sel;
  }

  _buildModeCounts() {
    const st = this.store.state;
    this.nBox.innerHTML = "";
    for (const n of this.loader.modeCounts(st.cfg)) {
      const b = document.createElement("button");
      b.textContent = String(n);
      b.dataset.n = String(n);
      b.className = "toggle";
      b.addEventListener("click", () => {
        const cur = new Set(this.store.state.n);
        if (cur.has(n)) cur.delete(n);
        else cur.add(n);
        if (cur.size === 0) cur.add(n); // never empty
        this.store.set({ n: [...cur].sort((a, c) => a - c) });
      });
      this.nBox.appendChild(b);
    }
  }

  _buildSlider() {
    const st = this.store.state;
    this.tBox.innerHTML = "";
    const times = this.loader.startTimes(st.cfg, st.n[0]);
    this.times = times;
    const s = (this.slider = document.createElement("input"));
    s.type = "range";
    s.min = "0";
    s.max = String(times.length - 1);
    s.step = "1";
    s.value = String(Math.max(0, times.indexOf(st.t[0])));
    const out = (this.tOut = document.createElement("span"));
    out.className = "readout";
    out.textContent = `${times[Number(s.value)]}`;
    // Ruling 2: "input", so the plot already changes during the drag.
    s.addEventListener("input", () => {
      const t = times[Number(s.value)];
      out.textContent = `${t}`;
      // User request 2026-09-18: the plot keeps its current range when t_start
      // changes. Axes with a fixed default already do; this freezes the rest.
      this.store.set({ t: [t], z: freezeDrawnWindows(this.store.state) });
    });
    this.tBox.appendChild(s);
    this.tBox.appendChild(out);

    const pin = document.createElement("button");
    pin.textContent = "pin";
    pin.className = "pin-btn";
    pin.addEventListener("click", () => {
      const cur = this.store.state;
      const pins = [...cur.pins];
      for (const n of cur.n) {
        for (const t of cur.t) {
          if (!pins.some((q) => q.cfg === cur.cfg && q.n === n && q.t === t)) {
            pins.push({ cfg: cur.cfg, n, t });
          }
        }
      }
      this.store.set({ pins });
    });
    this.tBox.appendChild(pin);
  }

  _buildParams() {
    this.pBox.innerHTML = "";
    for (const k of PARAM_KEYS) {
      const b = document.createElement("button");
      b.textContent = getParam(k).label;
      b.dataset.p = k;
      b.className = "toggle";
      b.addEventListener("click", () => {
        const cur = [...this.store.state.p];
        const i = cur.indexOf(k);
        if (i >= 0) {
          if (cur.length > 2) cur.splice(i, 1); // a corner needs at least two
        } else cur.push(k);
        this.store.set({ p: cur });
      });
      this.pBox.appendChild(b);
    }
  }

  /**
   * The credible levels, INDIVIDUALLY TOGGLEABLE (request 2).
   *
   * Unlike `n_modes` and `params`, the empty selection is LEGAL here: the user
   * asked to be able to show no contour lines at all. So there is no
   * "never empty" clamp.
   */
  _buildLevels() {
    this.levBox.innerHTML = "";
    for (const L of CREDIBLE_LEVELS) {
      const b = document.createElement("button");
      b.textContent = String(L);
      b.dataset.lev = String(L);
      b.className = "toggle";
      b.addEventListener("click", () => {
        const cur = levelsOf(this.store.state);
        const next = cur.includes(L) ? cur.filter((x) => x !== L) : [...cur, L];
        this.store.set({ levs: next.sort((a, c) => a - c) });
      });
      this.levBox.appendChild(b);
    }
  }

  /**
   * The contour smoothing slider (request 3: "contours too noisy").
   *
   * Discrete stops, not a continuum, because sigma is part of the contour
   * worker's memo key and a continuous slider would miss that cache on every
   * pointer move (see config.SMOOTH_SIGMAS). Fires on `input`, matching the
   * t_start slider, so the contours change during the drag (ruling 2).
   */
  _buildSmooth() {
    this.sigBox.innerHTML = "";
    const s = (this.sigSlider = document.createElement("input"));
    s.type = "range";
    s.min = "0";
    s.max = String(SMOOTH_SIGMAS.length - 1);
    s.step = "1";
    const cur = SMOOTH_SIGMAS.indexOf(this.store.state.sig);
    s.value = String(cur >= 0 ? cur : SMOOTH_SIGMAS.indexOf(1.0));
    const out = (this.sigOut = document.createElement("span"));
    out.className = "readout";
    out.textContent = String(SMOOTH_SIGMAS[Number(s.value)]);
    s.addEventListener("input", () => {
      const v = SMOOTH_SIGMAS[Number(s.value)];
      out.textContent = String(v);
      this.store.set({ sig: v });
    });
    this.sigBox.appendChild(s);
    this.sigBox.appendChild(out);
  }

  _buildScatter() {
    this.scBox.innerHTML = "";
    const b = document.createElement("button");
    b.textContent = "Tier 2 points";
    b.className = "toggle";
    b.dataset.sc = "1";
    b.addEventListener("click", () => this.store.set({ scatter: !this.store.state.scatter }));
    this.scBox.appendChild(b);
    this.scBtn = b;
    this._buildPrior();
  }

  /** Prior overlay toggle (user request 2026-09-18). Drawn by the corner view. */
  _buildPrior() {
    this.prBox.innerHTML = "";
    const b = document.createElement("button");
    b.textContent = "show prior";
    b.className = "toggle";
    b.dataset.pr = "1";
    b.title = "Corner view: prior bounds and 1D prior marginals, grey dotted";
    b.addEventListener("click", () => this.store.set({ prior: !this.store.state.prior }));
    this.prBox.appendChild(b);
    this.prBtn = b;
  }

  /**
   * One toggle per Kerr prediction blob (f-gamma view).
   *
   * Nine labels, INDIVIDUALLY toggleable, and the empty selection is LEGAL —
   * the same rule the credible levels follow. `config.KERR9_DEFAULT_LABELS`
   * (2.2.0 and 2.2.1) are on when the page opens, so the view's shipped
   * appearance is the two predictions it drew before the blobs existed.
   */
  _buildKerrLabels() {
    this.kmBox.innerHTML = "";
    for (const lab of KERR_BLOB_MODE_LABELS) {
      const b = document.createElement("button");
      b.textContent = lab;
      b.dataset.km = lab;
      b.className = "toggle";
      b.title = `Kerr ${lab} prediction blob from the IMR posterior`;
      b.addEventListener("click", () => {
        const cur = kerrLabelsOf(this.store.state);
        const next = cur.includes(lab) ? cur.filter((x) => x !== lab) : [...cur, lab];
        // Kept in KERR_BLOB_MODE_LABELS order, so the hash of a given set is
        // one string whatever order the user clicked them in.
        this.store.set({ km: KERR_BLOB_MODE_LABELS.filter((x) => next.includes(x)) });
      });
      this.kmBox.appendChild(b);
    }
  }

  /**
   * One dropdown per configuration axis of the Stage-3 mode assignment.
   *
   * The OPTIONS COME FROM THE PAYLOAD (`modeassign.json` -> `axes`), never from
   * a list in this file: the configuration grid that was actually computed is a
   * property of the payload, and offering a value that was not computed would
   * show an empty table as if it were a result. So the row is built only once
   * the file is resident, and rebuilt if the axes ever change.
   *
   * Every dropdown carries an "(default)" option with the empty value, which
   * removes the axis from the state and lets the payload's own `default_config`
   * decide. That is what makes ruling 10's default reachable again after a
   * change, without this file knowing what the default is.
   */
  _buildModeAssign() {
    const doc = this.loader.modeAssignCached();
    if (doc === undefined) {
      this._maAxesKey = null;
      this.maBox.innerHTML = "";
      return;
    }
    const key = JSON.stringify(doc.axes);
    if (key === this._maAxesKey) return;
    this._maAxesKey = key;
    this.maBox.innerHTML = "";
    for (const axis of MODEASSIGN_AXES) {
      const values = Array.isArray(doc.axes[axis]) ? doc.axes[axis] : [];
      const sel = document.createElement("select");
      sel.dataset.ma = axis;
      sel.title = axis;
      const def = document.createElement("option");
      def.value = "";
      def.textContent = `${axis}: default`;
      sel.appendChild(def);
      for (const v of values) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = `${axis}: ${v}`;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        const ma = { ...(this.store.state.ma ?? {}) };
        if (sel.value === "") delete ma[axis];
        else ma[axis] = sel.value;
        this.store.set({ ma });
      });
      this.maBox.appendChild(sel);
    }
  }

  /**
   * The `(n_modes, delta_t)` dropdowns of the amplitude/phase pair of views,
   * plus the absolute/relative selector.
   *
   * SAME RULE AS `_buildModeAssign`: the options come from the PAYLOAD
   * (`ampphase.json` -> `axes`), never from a list in this file, because the
   * grid that was computed is a property of the payload. The empty option
   * removes the axis from the state and lets the payload's own default decide.
   *
   * The two axes are a SUBSET of the mode-assignment axes and are kept in a
   * SEPARATE state key (`ap`, not `ma`): the two payloads are built from
   * different products and one can carry a configuration the other does not, so
   * a shared key would let a selection valid in one view silently empty the
   * other.
   */
  _buildAmpPhase() {
    const doc = this.loader.ampPhaseCached();
    if (doc === undefined) {
      this._apAxesKey = null;
      this.apBox.innerHTML = "";
      return;
    }
    const key = JSON.stringify(doc.axes);
    if (key === this._apAxesKey) return;
    this._apAxesKey = key;
    this.apBox.innerHTML = "";
    for (const axis of AMPPHASE_AXES) {
      const values = Array.isArray(doc.axes[axis]) ? doc.axes[axis] : [];
      const sel = document.createElement("select");
      sel.dataset.ap = axis;
      sel.title = axis;
      const def = document.createElement("option");
      def.value = "";
      def.textContent = `${axis}: default`;
      sel.appendChild(def);
      for (const v of values) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = `${axis}: ${v}`;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        const ap = { ...(this.store.state.ap ?? {}) };
        if (sel.value === "") delete ap[axis];
        else ap[axis] = sel.value;
        this.store.set({ ap });
      });
      this.apBox.appendChild(sel);
    }
    const msel = (this.apModeSel = document.createElement("select"));
    msel.dataset.apm = "mode";
    msel.title = "absolute quantities, or relative to the mode assigned 2.2.0";
    for (const [value, text] of [
      ["absolute", "absolute: A_R, A_L, phi_R, phi_L"],
      ["relative", "relative to 2.2.0"],
    ]) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      msel.appendChild(o);
    }
    msel.addEventListener("change", () => this.store.set({ apm: msel.value }));
    this.apBox.appendChild(msel);
  }

  /** Re-mark the active buttons and rebuild the pin chips from state. */
  sync() {
    const st = this.store.state;
    if (this.evSel) this.evSel.value = st.ev;
    if (this.cfgSel) this.cfgSel.value = st.cfg;
    if (this.viewSel) this.viewSel.value = st.view;
    for (const b of this.nBox.querySelectorAll("button")) {
      b.classList.toggle("on", st.n.includes(Number(b.dataset.n)));
    }
    for (const b of this.pBox.querySelectorAll("button")) {
      b.classList.toggle("on", st.p.includes(b.dataset.p));
    }
    const levs = levelsOf(st);
    for (const b of this.levBox.querySelectorAll("button")) {
      b.classList.toggle("on", levs.includes(Number(b.dataset.lev)));
    }
    if (this.sigSlider) {
      const i = SMOOTH_SIGMAS.indexOf(st.sig);
      if (i >= 0 && Number(this.sigSlider.value) !== i) {
        this.sigSlider.value = String(i);
        this.sigOut.textContent = String(st.sig);
      }
    }
    for (const b of this.kmBox.querySelectorAll("button")) {
      b.classList.toggle("on", kerrLabelsOf(st).includes(b.dataset.km));
    }
    this._buildModeAssign();
    for (const sel of this.maBox.querySelectorAll("select")) {
      const v = (st.ma ?? {})[sel.dataset.ma];
      sel.value = v === undefined ? "" : String(v);
    }
    // A view-specific row is hidden, not removed: the state it edits still
    // round-trips through the hash when another view is showing.
    if (this.kmRow) this.kmRow.style.display = st.view === "fgamma" ? "" : "none";
    this._buildAmpPhase();
    for (const sel of this.apBox.querySelectorAll("select[data-ap]")) {
      const v = (st.ap ?? {})[sel.dataset.ap];
      sel.value = v === undefined ? "" : String(v);
    }
    if (this.apModeSel) this.apModeSel.value = ampPhaseMode(st);
    if (this.maRow) this.maRow.style.display = st.view === "modeassign" ? "" : "none";
    // ONE row for the two views that share the file and the selection.
    if (this.apRow) {
      this.apRow.style.display =
        st.view === "ampphase" || st.view === "consistency" ? "" : "none";
    }
    if (this.scBtn) this.scBtn.classList.toggle("on", st.scatter);
    if (this.prBtn) this.prBtn.classList.toggle("on", st.prior);
    if (this.slider && this.times) {
      const i = this.times.indexOf(st.t[0]);
      if (i >= 0 && Number(this.slider.value) !== i) {
        this.slider.value = String(i);
        this.tOut.textContent = `${st.t[0]}`;
      }
    }
    this._syncPins();
  }

  _syncPins() {
    const st = this.store.state;
    this.pinBox.innerHTML = "";
    st.pins.forEach((q, idx) => {
      const chip = document.createElement("span");
      chip.className = "pin-chip";
      chip.style.borderColor = pinColor(idx);
      const dot = document.createElement("span");
      dot.className = "pin-dot";
      dot.style.background = pinColor(idx);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(` ${runKey(q.cfg, q.n, q.t)} `));
      const x = document.createElement("button");
      x.textContent = "×";
      x.className = "pin-x";
      x.addEventListener("click", () => {
        const pins = st.pins.filter((_, k) => k !== idx);
        this.store.set({ pins });
      });
      chip.appendChild(x);
      this.pinBox.appendChild(chip);
    });
  }
}
