// Human-like execution engine — a browser port of the Playwright motor in
// hackathon-karumi/human_demo.py. It makes the guide fill the form the way a
// person would: a painted cursor glides on a curve to each field, types letter
// by letter (with the odd typo it corrects), opens custom dropdowns and walks
// the options before clicking, and scrolls with a little overshoot.
//
// Everything here is pure DOM, so it runs in the page (no Playwright). Each
// long-running step takes a `keepGoing()` predicate: the moment it returns false
// (the user barged in by speaking) the motor bails out mid-action.
(function () {
  // ---- Tunables (mirror human_demo.py) ----------------------------------------
  const READ_LATENCY = [1500, 3000]; // initial pause: "read" the form before touching it
  const COG_PAUSE = { short: [250, 600], long: [800, 1600] }; // think before each field
  const TYPO_PROB = 0.3; // chance of making (and fixing) a typo per text field
  const OVERSHOOT = [0.08, 0.15]; // scroll: fraction you overshoot before correcting
  const TYPE_DELAY = [60, 130]; // ms per typed character
  const MOVE_DUR = 600; // ms for a cursor glide
  const MOVE_STEPS = 36;
  const OPT_WALK_PAUSE = 180; // ms hovering each dropdown option

  // ---- small utils ------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const randint = (lo, hi) => Math.floor(rand(lo, hi + 1));
  const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const always = () => true;

  // ---- painted cursor (window.__cur / __hover / __shape from CURSOR_INIT) -----
  const ARROW =
    '<svg width="26" height="26" viewBox="0 0 24 24">' +
    '<path d="M4 2 L4 21 L9.5 15.5 L13 23 L16 21.7 L12.5 14.5 L20 14.5 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const BEAM =
    '<svg width="26" height="26" viewBox="0 0 24 24">' +
    '<path d="M8 5 H16 M12 5 V19 M8 19 H16" fill="none" stroke="#fff" ' +
    'stroke-width="2" stroke-linecap="round"/></svg>';
  const HAND =
    '<svg width="26" height="26" viewBox="0 0 24 24">' +
    '<path d="M9.2 12 V4.6 a1.5 1.5 0 0 1 3 0 V9.2 q.6 -.7 1.5 -.7 ' +
    'a1.4 1.4 0 0 1 1.4 1.4 V10 q.6 -.6 1.4 -.6 a1.4 1.4 0 0 1 1.4 1.4 V11 ' +
    'q.6 -.5 1.3 -.5 a1.3 1.3 0 0 1 1.3 1.3 V16 a5 5 0 0 1 -5 5 h-2.8 ' +
    'a4.5 4.5 0 0 1 -3.6 -1.8 L5 15.4 a1.5 1.5 0 0 1 2.3 -1.9 L9.2 15 Z" ' +
    'fill="#fff" stroke="#111" stroke-width="1.1" stroke-linejoin="round"/></svg>';

  let curpos = [40, 40];

  // Cursor shape based on what's under it (like the real OS cursor).
  function shape(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return "arrow";
    const tag = el.tagName;
    const t = (el.type || "").toLowerCase();
    if (
      tag === "TEXTAREA" ||
      (tag === "INPUT" &&
        ["text", "email", "tel", "search", "url", "password", "number", ""].indexOf(t) >= 0)
    )
      return "text";
    const cur = getComputedStyle(el).cursor;
    if (cur === "text") return "text";
    if (cur === "pointer") return "hand";
    if (el.closest("button,a,label,select,[role=option],[role=button]")) return "hand";
    return "arrow";
  }

  function cur(x, y) {
    let c = document.getElementById("hc");
    if (!c) {
      c = document.createElement("div");
      c.id = "hc";
      c.style.cssText =
        "position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;" +
        "pointer-events:none;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6));" +
        "transition:transform .04s linear";
      document.body.appendChild(c);
    }
    const k = shape(x, y); // reactive shape, not fixed by the script
    if (c.dataset.kind !== k) {
      c.innerHTML = k === "text" ? BEAM : k === "hand" ? HAND : ARROW;
      c.dataset.kind = k;
    }
    const off = k === "text" ? [13, 13] : k === "hand" ? [11, 3] : [4, 2]; // hotspot per shape
    c.style.transform = "translate(" + (x - off[0]) + "px," + (y - off[1]) + "px)";
    curpos = [x, y];
  }

  function hover(x, y) {
    if (!document.getElementById("demo-hover-style")) {
      const st = document.createElement("style");
      st.id = "demo-hover-style";
      st.textContent = ".dd-opt.demo-hover{background:rgba(26,115,232,.18)!important;}";
      (document.head || document.documentElement).appendChild(st);
    }
    document.querySelectorAll(".dd-opt.demo-hover").forEach((o) => o.classList.remove("demo-hover"));
    const el = document.elementFromPoint(x, y);
    const opt = el && el.closest && el.closest(".dd-opt");
    if (opt) opt.classList.add("demo-hover");
  }

  function initCursor() {
    cur(40, 40);
  }

  function removeCursor() {
    const c = document.getElementById("hc");
    if (c) c.remove();
    document.querySelectorAll(".dd-opt.demo-hover").forEach((o) => o.classList.remove("demo-hover"));
  }

  // ---- movement ---------------------------------------------------------------
  // Glide the painted cursor along a bezier curve (not a straight line).
  async function moveCursor(x0, y0, x1, y1, keepGoing) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy) || 1;
    const off = rand(0.12, 0.28) * dist * choice([-1, 1]); // curvature
    const cx = (x0 + x1) / 2 + (-dy / dist) * off;
    const cy = (y0 + y1) / 2 + (dx / dist) * off;
    for (let i = 1; i <= MOVE_STEPS; i++) {
      if (!keepGoing()) return;
      const t = i / MOVE_STEPS;
      const te = t * t * (3 - 2 * t); // ease-in-out: starts and stops like a hand
      const u = 1 - te;
      const bx = u * u * x0 + 2 * u * te * cx + te * te * x1;
      const by = u * u * y0 + 2 * u * te * cy + te * te * y1;
      cur(bx, by);
      hover(bx, by);
      await sleep(MOVE_DUR / MOVE_STEPS + rand(0, 4));
    }
  }

  // Bring a field near the viewport with human scroll: steps, overshoot, correction.
  async function scrollIntoViewHuman(el, keepGoing) {
    const r0 = el.getBoundingClientRect();
    const h = window.innerHeight;
    let need = 0;
    if (r0.top > h * 0.85) need = r0.top - h * 0.5;
    else if (r0.top < h * 0.1) need = r0.top - h * 0.4;
    if (Math.abs(need) < 4) return;

    const over = need * rand(OVERSHOOT[0], OVERSHOOT[1]); // overshoot a bit
    const target = need + over;
    const steps = Math.max(6, Math.round(Math.abs(target) / 60));
    for (let i = 0; i < steps; i++) {
      if (!keepGoing()) return;
      window.scrollBy(0, target / steps); // real wheel-like scroll: more human than scrollTo
      await sleep(rand(30, 70));
    }
    await sleep(rand(100, 250)); // micro-pause on noticing the overshoot
    const back = Math.max(3, Math.round(Math.abs(over) / 40));
    for (let i = 0; i < back; i++) {
      if (!keepGoing()) return;
      window.scrollBy(0, -over / back); // correct the overshoot
      await sleep(rand(30, 70));
    }
  }

  // Scroll the field into view, then curve the cursor to its center.
  async function glide(el, keepGoing) {
    await scrollIntoViewHuman(el, keepGoing);
    if (!keepGoing()) return;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) return;
    const x1 = box.x + box.width / 2;
    const y1 = box.y + box.height / 2;
    await moveCursor(curpos[0], curpos[1], x1, y1, keepGoing);
  }

  // ---- typing -----------------------------------------------------------------
  async function think(level, keepGoing) {
    const [lo, hi] = COG_PAUSE[level] || COG_PAUSE.short;
    const total = rand(lo, hi);
    const slice = 60;
    for (let waited = 0; waited < total; waited += slice) {
      if (!keepGoing()) return;
      await sleep(Math.min(slice, total - waited));
    }
  }

  // Type char by char into a value-bearing input; occasionally fumble and fix it.
  async function typeText(el, text, keepGoing) {
    const errAt =
      text.length > 4 && Math.random() < TYPO_PROB ? randint(2, text.length - 1) : -1;
    el.value = "";
    for (let i = 0; i < text.length; i++) {
      if (!keepGoing()) return;
      el.value += text[i];
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(randint(TYPE_DELAY[0], TYPE_DELAY[1]));
      if (i === errAt) {
        const junk = Array.from({ length: randint(1, 3) }, () => choice("asdfghjkl".split(""))).join("");
        for (const j of junk) {
          if (!keepGoing()) return;
          el.value += j;
          await sleep(randint(TYPE_DELAY[0], TYPE_DELAY[1]));
        }
        await sleep(rand(200, 500));
        for (let k = 0; k < junk.length; k++) {
          if (!keepGoing()) return;
          el.value = el.value.slice(0, -1); // backspace the junk
          await sleep(rand(40, 100));
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  // ---- high-level actions (mirror human_type / human_click / human_pick) ------
  async function type(el, text, opts = {}) {
    const keepGoing = opts.keepGoing || always;
    await think(opts.think || "short", keepGoing);
    if (!keepGoing()) return;
    await glide(el, keepGoing); // cursor turns into a beam over the input on its own
    if (!keepGoing()) return;
    el.focus();
    await typeText(el, text, keepGoing);
    await sleep(350);
  }

  async function click(el, opts = {}) {
    const keepGoing = opts.keepGoing || always;
    await think(opts.think || "short", keepGoing);
    if (!keepGoing()) return;
    await glide(el, keepGoing);
    if (!keepGoing()) return;
    el.click();
    await sleep((opts.pause ?? 0.5) * 1000);
  }

  // Open the custom dropdown, walk the cursor over the options, pick one.
  async function pick(ddSelector, value, opts = {}) {
    const keepGoing = opts.keepGoing || always;
    const dd = document.querySelector(ddSelector);
    if (!dd) return;
    const btn = dd.querySelector(".dd-btn");
    await click(btn, { keepGoing, pause: 0.45 }); // opens the list
    if (!keepGoing()) return;
    const options = Array.from(dd.querySelectorAll(".dd-opt"));
    let chosen = options[0];
    for (const opt of options) {
      if (!keepGoing()) return;
      await glide(opt, keepGoing); // highlights each option as it passes over it
      await sleep(OPT_WALK_PAUSE);
      chosen = opt;
      if (opt.getAttribute("data-value") === value) break;
    }
    if (!keepGoing() || !chosen) return;
    chosen.click(); // selects, sets the hidden input and closes (wired by the form)
    await sleep((opts.pause ?? 0.5) * 1000);
  }

  // Initial "reading the form" pause before touching anything.
  async function readPause(keepGoing) {
    await sleep(rand(READ_LATENCY[0], READ_LATENCY[1]));
    void keepGoing;
  }

  window.Human = {
    initCursor,
    removeCursor,
    glide,
    type,
    click,
    pick,
    readPause,
    READ_LATENCY,
  };
})();
