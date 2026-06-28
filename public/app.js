// Interactive voice demo guide — frontend state machine.
//
// The guide narrates a demo, fills the form human-like (see human.js), and behaves
// like a patient, empathetic person with strict, forward-only memory of progress:
//
//   - VAD: the instant the user talks, the guide stops. It never talks over you.
//   - Interruption: it stops, snapshots progress, and — if you haven't asked yet —
//     gives a short, rotating acknowledgement, then WAITS INDEFINITELY (no timeout).
//   - Q&A loop: after answering it asks a rotating clarity check ("Does that clear it up?")
//     ONLY when it helps — the brain flags this per answer (checkIn), and we skip it when the
//     answer already ends in a question or was a mere reaction. Another question -> answer
//     again; a "no" to the clarity check -> clarify; approval/"carry on"/silence -> resume.
//   - Resume: a rotating transition, then it continues from the exact checkpoint —
//     it NEVER re-runs steps/fields already completed (strict, one-way progress).
//
// Progress is tracked at action granularity: stepIndex + actionIndex (+ whether the
// current step's narration was delivered). A completed action's index is advanced and
// never revisited; an interrupted (incomplete) action re-runs, a completed one does not.
//
// Modes (drive the orb + status): idle | narrating | listening | answering.
//
// LANGUAGE: the spoken phrase pools below are English to match the English-only demo.
// To speak Spanish, translate the pools and switch the ear's language: rec.lang = "es-ES"
// in setupBrowserRecognition() and language: "es" in the Deepgram params (startDeepgramEar()).

const els = {
  status: document.getElementById("status"),
  orb: document.getElementById("orb"),
  transcript: document.getElementById("transcript"),
  startBtn: document.getElementById("startBtn"),
  continueBtn: document.getElementById("continueBtn"),
  repeatBtn: document.getElementById("repeatBtn"),
  stopBtn: document.getElementById("stopBtn"),
};

const state = {
  mode: "idle",
  stepIndex: 0,       // step the guide is on
  actionIndex: 0,     // next action within the current step to run (completed ones are < this)
  narrated: false,    // has the current step's narration been fully delivered?
  history: [],        // [{role, content}] sent to Claude for context
  audio: null,        // current HTMLAudioElement
  audioResolve: null, // resolver of the in-flight speak() promise (so stopAudio settles it)
  busy: false,        // awaiting a Claude answer over the network (don't accept new input)
  sessionActive: false,
  userTurn: false,    // the user has the floor
  waitingFor: null,   // "question" (after an interruption) | "validation" (Q&A loop) | null
  acked: false,       // have we already acknowledged this interruption? (pause/validation holds)
  quietBeats: 0,      // silence nudges spoken while waiting for a question (escalates: ask, re-ask, carry on)
  visited: {},        // sections already shown {dashboard,contacts,pipeline,comms} -> true (demo memory)
  checkinStyle: "clarity", // which post-answer check-in was asked: "more" | "confirm" | "clarity" (routes yes/no)
  gen: 0,             // turn generation; bumping it invalidates any in-flight speak sequence
  ackTimer: null,
  echoWords: [],      // normalized words of what the agent is saying RIGHT NOW (anti-echo ref)
  echoPrevWords: [],  // the phrase before it (STT lag can still be transcribing it)
  audioEndedAt: 0,    // when the last TTS audio stopped — echo can linger briefly after
  micStream: null,    // echo-cancelled mic stream (getUserMedia) fed into the recognizer
  aecActive: false,   // did we successfully route an echo-cancelled track into recognition?
  bargePrimed: false, // barge-in debounce: a candidate interim awaiting a second confirmation
  sttEngine: "browser", // "deepgram" | "browser" — current ear (set from /api/ear)
  dgSocket: null,     // WebSocket to our /api/listen Deepgram proxy
  dgRecorder: null,   // MediaRecorder feeding audio into that socket
  dgFinalBuf: "",     // accumulated is_final segments until the utterance ends (then flushed)
};

let DEMO = null;
let DG_MODEL = "nova-3"; // Deepgram model, set from /api/ear at init

// ---- Conversational timing + phrase pools ------------------------------------
const ACK_DELAY = [900, 1800];  // intentional human pause before acknowledging an interruption
const QUIET_DELAY = [4000, 6000]; // silence to tolerate before the next nudge while awaiting a question
const BARGE_MIN_WORDS = 2;      // VAD floor: ignore <2-word fragments (noise / garbled pickup)
const BARGE_CONFIRM_WORDS = 3;  // >= this many words cuts in instantly; 2 words must persist a tick
const STEP_GAP = 800;           // pause between steps
const ECHO_TAIL_MS = 1200;      // keep filtering echo this long after audio stops (STT lag)
const ECHO_MIN_RUN = 3;         // a verbatim run of >= this many of OUR words back == speaker echo

const ACKS = [
  "Of course — what's your question?",
  "Sure, go ahead.",
  "Go ahead, I'm listening.",
  "Sure — what would you like to ask?",
];
// Said on the NEXT silence after we already invited the question once — a gentle re-ask.
const REPROMPTS = [
  "Sorry — what was your question?",
  "Go ahead, what did you want to ask?",
  "I'm still here — what's on your mind?",
];
// Said after a SECOND silence: assume the question's gone and carry on. This REPLACES the
// usual transition line, so we resume without speaking another one on top of it.
const GIVEUPS = [
  "No question? No worries — I'll carry on, just jump in when it comes to you.",
  "Alright, all good — let's keep going.",
  "Okay, I'll continue — stop me anytime.",
];
// CLARITY checks only — every one means the same thing, so "no" is unambiguous: it always
// means "not clear -> clarify". (Do NOT add "any other questions?"-style prompts here: there
// a "no" means "carry on", inverting the routing and causing the answer-no-asks-again loop.)
const VALIDATIONS = [
  "Does that clear it up?",
  "Did that answer your question?",
  "Does that make sense?",
  "Is that clearer now?",
];
// Two more check-in STYLES, rotated together with the clarity check above so the post-answer
// follow-up never feels canned. Each style routes yes/no DIFFERENTLY (see handleUtterance),
// so the spoken question and the interpretation of the reply always match.
const CHECKIN_MORE = [    // "no / that's all" -> carry on;  a question -> answer it
  "Anything else, or shall I carry on?",
  "Any other questions, or should I keep going?",
  "Anything more you'd like to see?",
];
const CHECKIN_CONFIRM = [ // "yes / continue" -> carry on;  "no / not yet" -> they have more
  "Want me to carry on?",
  "Shall I keep going?",
  "Ready to move on?",
];
const CLARIFIES = [
  "No problem — what part should I go over?",
  "Sure — what would you like me to explain?",
];
const TRANSITIONS = [
  "Perfect, let's pick up where we left off…",
  "Alright, moving on…",
  "Great, let's continue…",
  "Okay, back to it…",
];
// Said once when the user closes the conversation, then the session ENDS — no
// validation, no "is that clear?" after a goodbye (see farewell()).
const FAREWELLS = [
  "Thanks for your time — have a great day!",
  "My pleasure. Take care!",
  "Glad I could help. Have a good one!",
];
// When the user asks for a moment, react like a person: accept the pause AND gently ask
// what they need, then WAIT (indefinitely) for their question — never resume on our own.
const PAUSES = [
  "Sure — what's up?",
  "Of course. What's on your mind?",
  "No rush — what would you like to know?",
  "Sure thing. What is it?",
];

// Pick from a pool without ever repeating the previous choice.
function makeRotator(items) {
  let last = -1;
  return () => {
    let i;
    do {
      i = Math.floor(Math.random() * items.length);
    } while (items.length > 1 && i === last);
    last = i;
    return items[i];
  };
}
const pickAck = makeRotator(ACKS);
const pickValidation = makeRotator(VALIDATIONS);
const pickMore = makeRotator(CHECKIN_MORE);
const pickConfirm = makeRotator(CHECKIN_CONFIRM);
const pickCheckinStyle = makeRotator(["more", "confirm", "clarity"]); // rotate so it varies
const pickClarify = makeRotator(CLARIFIES);
const pickTransition = makeRotator(TRANSITIONS);
const pickFarewell = makeRotator(FAREWELLS);
const pickPause = makeRotator(PAUSES);
const pickReprompt = makeRotator(REPROMPTS);
const pickGiveUp = makeRotator(GIVEUPS);

const randInt = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));

// ---- UI helpers ---------------------------------------------------------------
function setMode(mode, statusText) {
  state.mode = mode;
  if (els.orb) els.orb.className = "orb " + (mode === "idle" ? "idle" : mode);
  if (els.status) els.status.textContent = statusText || mode;
  els.continueBtn.disabled = !state.sessionActive;
  els.repeatBtn.disabled = !state.sessionActive;
  els.stopBtn.disabled = !state.sessionActive;
  els.startBtn.disabled = state.sessionActive;
}

function addMsg(who, text) {
  if (!els.transcript) return; // transcript panel removed from the UI — nothing to show
  const div = document.createElement("div");
  div.className = "msg " + (who === "You" ? "user" : "guide");
  div.innerHTML = `<span class="who">${who}</span>${escapeHtml(text)}`;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Visual step highlight removed by request — keep the function as a no-op so the existing
// call sites stay valid. (We clear any stray highlight class just in case.)
function highlightField() {
  document.querySelectorAll(".highlight").forEach((e) => e.classList.remove("highlight"));
}

// Discreet, auto-dismissing notice — only used to surface critical problems (e.g. the mic is
// blocked, or speech recognition isn't available), so the tester is never left guessing why
// nothing happened. Created on the fly so it adds no clutter in the happy path.
let noticeTimer = null;
function notify(msg) {
  let n = document.getElementById("notice");
  if (!n) {
    n = document.createElement("div");
    n.id = "notice";
    n.style.cssText =
      "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2000;" +
      "background:rgba(58,29,29,.96);color:#ffdada;border:1px solid #7a3b3b;padding:11px 16px;" +
      "border-radius:10px;font:14px/1.45 system-ui,sans-serif;max-width:540px;text-align:center;" +
      "box-shadow:0 8px 28px rgba(0,0,0,.45);";
    document.body.appendChild(n);
  }
  n.textContent = msg;
  n.style.display = "block";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { n.style.display = "none"; }, 8000);
}

// ---- Voice output (ElevenLabs via our /api/tts) -------------------------------
// FULL-DUPLEX: the mic stays live while the agent speaks, so the user can barge in and cut
// it off at ANY moment (the core feature). The agent NOT reacting to its own TTS off the
// speaker is handled WITHOUT muting the mic — by the anti-echo layers (AEC in capture +
// isEcho() text filter + barge-in debounce), see "Anti-echo". speak() resolves on natural
// end, on error, OR when stopAudio() cuts it short — so every `await speak(...)` settles
// deterministically and the flow can react.
function speak(text) {
  return new Promise((resolve) => {
    stopAudio();
    // Anti-echo: remember what we're about to say so the mic picking it back up off the
    // speaker can be recognized as our own voice and filtered (see isEcho()).
    state.echoPrevWords = state.echoWords;
    state.echoWords = normalizeWords(text);
    const url = "/api/tts?text=" + encodeURIComponent(text);
    const audio = new Audio(url);
    state.audio = audio;
    state.audioResolve = resolve;
    const done = () => {
      if (state.audio === audio) {
        state.audio = null;
        state.audioResolve = null;
        state.audioEndedAt = Date.now(); // echo can linger for a beat after audio stops
      }
      resolve();
    };
    audio.addEventListener("ended", done, { once: true });
    // The demo keeps going even if voice fails, but surface WHY instead of silence.
    audio.addEventListener("error", async () => {
      let reason = "audio playback error";
      try { reason = (await (await fetch(url)).text()).slice(0, 140) || reason; } catch {}
      console.error("Voice failed:", reason, "— check ELEVENLABS_API_KEY in .env and the server log.");
      if (els.status) els.status.textContent = "No voice: " + reason;
      done();
    }, { once: true });
    audio.play().catch(done);
  });
}

function stopAudio() {
  if (state.audio) {
    try { state.audio.pause(); } catch {}
    state.audio.src = "";
    const resolve = state.audioResolve;
    state.audio = null;
    state.audioResolve = null;
    state.audioEndedAt = Date.now(); // a cut phrase can still be echoing for a beat
    if (resolve) resolve(); // settle the pending speak() so its awaiter continues
  }
}

// True while the agent is producing output the user could talk over (speaking, or silently
// typing into the form mid-narration). Used to decide when to barge in.
function isAgentOutputting() {
  return state.mode === "narrating" || state.audio !== null;
}

// ---- Anti-echo (speaker feedback) ---------------------------------------------
// On a laptop without headphones the mic hears the agent's own TTS and the STT
// transcribes it, which would otherwise trigger a false barge-in or get answered as a
// "question". We tag the agent's recent speech and drop any input that is just it
// coming back — but ONLY while sound is (or just was) audible, so genuine Q&A that
// happens to reuse a word is never suppressed.
function normalizeWords(s) {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

// Length of the longest run of words that appears contiguously in BOTH arrays.
function longestWordRun(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagLeft = 0; // dp[i-1][j-1]
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagLeft + 1 : 0;
      if (dp[j] > best) best = dp[j];
      diagLeft = tmp;
    }
  }
  return best;
}

// Echo only makes sense while the speaker is (or just was) playing our voice.
function withinEchoWindow() {
  return isAgentOutputting() || Date.now() - state.audioEndedAt < ECHO_TAIL_MS;
}

// True if `text` is our own voice echoing back (a verbatim run of OUR recent words).
function isEcho(text) {
  if (!withinEchoWindow()) return false;
  const cand = normalizeWords(text);
  if (cand.length < 2) return false; // a single word is too weak to call echo; the VAD floor handles it
  const ref = state.echoWords.concat(state.echoPrevWords);
  if (!ref.length) return false;
  return longestWordRun(cand, ref) >= Math.min(ECHO_MIN_RUN, cand.length);
}

// ---- Turn + generation bookkeeping --------------------------------------------
function bumpGen() {
  return ++state.gen;
}

function clearTurnTimers() {
  clearTimeout(state.ackTimer);
  state.ackTimer = null;
}

function endUserTurn() {
  state.userTurn = false;
  state.waitingFor = null;
  state.acked = false;
  state.quietBeats = 0;
  state.bargePrimed = false;
  clearTurnTimers();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Demo runner (forward-only, checkpoint-aware) -----------------------------
// driving(): the run loop / form motor should keep going (narrating and live).
const driving = () => state.mode === "narrating" && state.sessionActive;
// alive(g): this run still owns the floor (not superseded by an interruption).
const alive = (g) => state.sessionActive && g === state.gen && driving();

const keepGoing = () => driving();

// Begin (or resume) auto-running the demo from the current checkpoint.
function startRun() {
  const g = bumpGen();
  setMode("narrating", `Step ${state.stepIndex + 1}/${DEMO.steps.length}`);
  runSteps(g);
}

// Which CRM section each demo step belongs to (for the demo's "what have we seen" memory).
const STEP_SECTION = {
  dashboard: "dashboard",
  contacts: "contacts", "new-contact": "contacts", "edit-contact": "contacts",
  pipeline: "pipeline", "advance-deal": "pipeline",
  comms: "comms", "draft-email": "comms",
};
function markVisited(idx) {
  const step = DEMO.steps[idx];
  const sec = step && STEP_SECTION[step.id];
  if (sec) state.visited[sec] = true;
}
const SECTION_ORDER = ["dashboard", "contacts", "pipeline", "comms"];
// First step of the first section not yet shown, or -1 if everything has been seen.
function firstUnvisitedSectionStart() {
  for (const sec of SECTION_ORDER) {
    if (!state.visited[sec]) {
      const i = DEMO.steps.findIndex((s) => STEP_SECTION[s.id] === sec);
      if (i >= 0) return i;
    }
  }
  return -1;
}
function doneIndex() {
  const i = DEMO.steps.findIndex((s) => s.id === "done");
  return i >= 0 ? i : DEMO.steps.length - 1;
}

// Jump the demo to a section the user asked for by voice and run it from the top of that
// step (it narrates the section, clicks its nav tab, and performs its actions).
function goToSection(id) {
  const idx = DEMO.steps.findIndex((s) => s.id === id);
  if (idx < 0 || !state.sessionActive) return;
  if (typeof window.__closeModals === "function") window.__closeModals(); // dismiss any open dialog
  stopAudio();   // cut any current narration so it doesn't overlap the new section
  endUserTurn();
  state.stepIndex = idx;
  state.actionIndex = 0;
  state.narrated = false;
  markVisited(idx);
  startRun();
}

async function runSteps(g) {
  while (alive(g) && state.stepIndex < DEMO.steps.length) {
    const step = DEMO.steps[state.stepIndex];
    markVisited(state.stepIndex); // remember this section was shown (even if later interrupted)

    // Narration and actions run TOGETHER, so the guide talks WHILE it acts (e.g. says
    // "let me add a contact" as the cursor clicks New contact). Narration is (re)spoken only
    // if it wasn't completed before; `narrated` flips the instant the speech finishes —
    // independent of the actions — so a later interruption doesn't force a re-narration.
    const actions = step.actions || (step.action ? [step.action] : []);
    let narrating = Promise.resolve();
    if (!state.narrated) {
      addMsg("Guide", step.narration);
      setMode("narrating", `Step ${state.stepIndex + 1}/${DEMO.steps.length}`);
      narrating = speak(step.narration).then(() => { if (alive(g)) state.narrated = true; });
    }

    // Actions: run only the not-yet-completed ones, concurrently with the narration. A
    // completed action's index is advanced and NEVER revisited (one-way progress).
    while (state.actionIndex < actions.length) {
      if (!alive(g)) return;
      await runAction(actions[state.actionIndex], g);
      if (!alive(g)) return; // interrupted mid-action -> keep index, re-run just this one
      state.actionIndex++;
    }

    await narrating;       // let any remaining narration finish before advancing
    if (!alive(g)) return; // interrupted during narration -> narrated stays false, re-narrate

    // Step fully done -> advance, but VISITED-AWARE. Mid-section steps just continue in order.
    // At a section boundary (or the end), head to the first section the user hasn't seen yet;
    // once everything's been shown, go to the wrap-up — and never re-loop the wrap-up. This is
    // what makes a jumped-around tour still cover the unseen sections, then stop.
    const finishedSec = STEP_SECTION[step.id];
    state.stepIndex++;
    state.actionIndex = 0;
    state.narrated = false;
    const nx = DEMO.steps[state.stepIndex];
    const nxSec = nx ? STEP_SECTION[nx.id] : null;
    if (nxSec !== finishedSec) {
      const j = firstUnvisitedSectionStart();
      if (j >= 0) state.stepIndex = j;
      else if (step.id !== "done") state.stepIndex = doneIndex();
    }
    if (state.stepIndex < DEMO.steps.length) {
      await wait(STEP_GAP);
      if (!alive(g)) return;
    }
  }
  if (state.sessionActive && g === state.gen && state.stepIndex >= DEMO.steps.length) {
    highlightField(null);
    enterListening();
  }
}

async function runAction(action, g) {
  // Gen-bound keepGoing: the moment the turn is superseded (barge-in OR a voice "go to X"),
  // alive(g) flips false and the in-flight motor (mid-typing, etc.) aborts at once instead of
  // finishing the field first. Falls back to the plain driving() check if no gen is given.
  const kg = g == null ? keepGoing : () => alive(g);
  if (action.type === "type") {
    const el = document.getElementById(action.field);
    if (el) await Human.type(el, action.value, { keepGoing: kg, think: action.think });
  } else if (action.type === "pick") {
    await Human.pick("#" + action.field, action.value, { keepGoing: kg });
  } else if (action.type === "check") {
    const input = document.getElementById(action.field);
    const label = input && input.closest("label");
    if (label && !input.checked) await Human.click(label, { keepGoing: kg });
  } else if (action.type === "click") {
    const el = document.getElementById(action.field);
    if (el) await Human.click(el, { keepGoing: kg, pause: 0.4 });
  }
}

// ---- Form helpers -------------------------------------------------------------
function rememberPlaceholders() {
  document.querySelectorAll(".dd-value").forEach((v) => {
    if (!v.dataset.placeholder) v.dataset.placeholder = v.textContent;
  });
}

function resetForm() {
  // The product (e.g. the CRM) can expose its own reset; it runs on every (re)start so a
  // replay starts from a clean state (no duplicated contacts, deals back to seed, etc.).
  if (typeof window.__resetProduct === "function") window.__resetProduct();
  const form = document.getElementById("signup");
  if (!form) return;
  form
    .querySelectorAll('input[type="text"], input[type="password"], input[type="hidden"]')
    .forEach((el) => (el.value = ""));
  form.querySelectorAll('input[type="checkbox"]').forEach((el) => (el.checked = false));
  form.querySelectorAll(".dropdown").forEach((dd) => {
    dd.classList.remove("open");
    const val = dd.querySelector(".dd-value");
    const btn = dd.querySelector(".dd-btn");
    if (val) {
      if (val.dataset.placeholder) val.textContent = val.dataset.placeholder;
      val.classList.add("placeholder");
    }
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
  const box = document.getElementById("success");
  if (box) {
    box.classList.remove("show", "error");
    box.textContent = "";
  }
}

function enterListening() {
  endUserTurn();
  setMode("listening", "Listening — ask a question, or say \"next\"");
}

// ---- Navigation commands ------------------------------------------------------
// Skip ahead: move strictly to the next step (does not refill the skipped one).
function nextStep() {
  endUserTurn();
  state.stepIndex = Math.min(state.stepIndex + 1, DEMO.steps.length);
  state.actionIndex = 0;
  state.narrated = false;
  if (state.stepIndex >= DEMO.steps.length) { highlightField(null); enterListening(); }
  else startRun();
}

// Re-explain the current step's narration WITHOUT redoing any completed fields.
async function repeatStep() {
  endUserTurn();
  const idx = Math.min(state.stepIndex, DEMO.steps.length - 1);
  state.stepIndex = idx;
  const g = bumpGen();
  setMode("answering", "…");
  const step = DEMO.steps[idx];
  addMsg("Guide", step.narration);
  await speak(step.narration);
  if (g !== state.gen || !state.sessionActive) return;
  state.narrated = true; // we just delivered it; runSteps continues from actionIndex
  startRun();
}

// ---- Interruption handling (empathetic, patient turn-taking) ------------------
// (Re)start the "user has gone quiet" countdown. The first beat waits a short human pause
// (ACK_DELAY); later beats tolerate more silence (QUIET_DELAY) before nudging again. Called
// on each word the user says so we never cut in early. Only runs in the "question" wait —
// a "pause" wait ("one moment") deliberately has no timer (we wait as long as they need).
function rescheduleQuiet() {
  if (state.waitingFor !== "question") return;
  clearTurnTimers();
  const g = state.gen;
  const [lo, hi] = state.quietBeats === 0 ? ACK_DELAY : QUIET_DELAY;
  state.ackTimer = setTimeout(() => onQuietBeat(g), randInt(lo, hi));
}

// The user took the floor (barged in over the agent): stop, snapshot is already kept in
// stepIndex/actionIndex/narrated, invalidate in-flight speech, then wait — indefinitely.
function onUserBargeIn() {
  state.userTurn = true;
  state.waitingFor = "question";
  state.acked = false;
  state.quietBeats = 0;                   // fresh escalation budget for this interruption
  state.bargePrimed = false;              // we committed — clear the debounce
  bumpGen();                              // invalidate in-flight answer/ack/transition awaits
  stopAudio();                            // VAD: never talk over the user
  setMode("listening", "I'm listening…"); // also flips driving() off, so the form-fill bails
  rescheduleQuiet();
}

// Fires after the user has been silent during a question wait. Escalate like a patient
// human: beat 1 invites the question, beat 2 gently re-asks, beat 3 assumes there's no
// question and carries on. Each spoken beat re-arms the next; the user speaking cancels it.
async function onQuietBeat(g) {
  if (g !== state.gen || !state.sessionActive || state.waitingFor !== "question") return;
  const beat = ++state.quietBeats;
  setMode("answering", "…");
  if (beat >= 3) {
    await speak(pickGiveUp());
    if (g !== state.gen || !state.sessionActive) return;
    endUserTurn();
    if (state.stepIndex >= DEMO.steps.length) return enterListening();
    return startRun(); // the give-up line WAS the transition — resume without another one
  }
  await speak(beat === 1 ? pickAck() : pickReprompt());
  if (g !== state.gen || !state.sessionActive) return;
  setMode("listening", beat === 1 ? "Listening — go ahead" : "Listening — still here");
  rescheduleQuiet();
}

// Shared core for "the user spoke but there's no question to answer yet": say a short
// line at most once, then keep waiting. NEVER validates — there's no doubt to resolve —
// and preserves the conversational phase so their next REAL utterance is routed right.
async function passiveHold(pickPhrase, listenMsg) {
  state.userTurn = true;
  clearTurnTimers();
  if (state.acked) { setMode("listening", listenMsg); return; } // already responded once
  const g = bumpGen();
  setMode("answering", "…");
  await speak(pickPhrase());
  if (g !== state.gen || !state.sessionActive) return;
  state.acked = true;
  setMode("listening", listenMsg);
}

// An unfinished opener during a VALIDATION wait ("um…"): invite them to finish, stay in
// validation (don't escalate or switch phase).
function passiveAck() {
  const msg = state.waitingFor === "validation" ? "Listening — does that help?" : "Listening — go ahead";
  return passiveHold(pickAck, msg);
}

// The user announced a question but hasn't asked it yet ("I have a question", "excuse me,
// I have a question", "what if…"). Invite it right away (beat 1), then escalate on silence:
// re-ask, then assume there's no question and carry on. This is the human "oh, what's up?"
// that waits for the question instead of barreling on.
function promptForQuestion() {
  state.userTurn = true;
  state.waitingFor = "question";
  state.quietBeats = 0;
  clearTurnTimers();
  return onQuietBeat(state.gen); // speak the invite now, then arm the silence escalation
}

// An explicit request for TIME ("hold on", "one moment", "give me a sec"). React like a
// person: accept the pause and gently ask what they need, then WAIT — a pause is NOT a
// pending question, so we mark the wait "pause" to suppress the silence escalation entirely.
function acceptPause() {
  state.waitingFor = "pause";
  return passiveHold(pickPause, "Listening — go ahead");
}

// ---- Q&A loop -----------------------------------------------------------------
async function answerQuestion(text) {
  state.userTurn = true;
  state.waitingFor = null;
  clearTurnTimers();
  const g = bumpGen();
  state.busy = true;
  stopAudio();
  setMode("answering", "Thinking…");
  addMsg("You", text);
  state.history.push({ role: "user", content: text });

  let answer = "Sorry, I didn't quite catch that — could you say it again?";
  let checkIn = false; // did the brain judge a "does that make sense?" worth asking?
  let goto = "";       // brain understood a navigation request -> jump to this section
  let done = false;    // brain judged the user is finished -> wrap up
  try {
    const r = await fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: text,
        stepIndex: state.stepIndex,
        history: state.history.slice(-6),
        visited: state.visited, // demo memory: which sections we've already shown
      }),
    });
    const data = await r.json();
    if (data.text) answer = data.text;
    checkIn = !!data.checkIn;
    goto = data.goto || "";
    done = !!data.done;
  } catch (e) {
    console.error(e);
  }
  state.busy = false;
  if (g !== state.gen || !state.sessionActive) return; // a newer interruption superseded this

  // The brain understood a navigation request (even a vague one) — jump there NOW instead of
  // answering, so the user is never told "let me finish this first".
  if (goto) return goToSection(goto);

  state.history.push({ role: "assistant", content: answer });
  addMsg("Guide", answer);
  setMode("answering", "Answering…");
  await speak(answer); // interruptible: the user can ask a follow-up over the answer
  if (g !== state.gen || !state.sessionActive) return;

  // The brain judged the user is finished / has seen enough — wrap up, do NOT resume.
  if (done) return endSession();

  // If our OWN answer ended by asking the user something, wait for their reply (don't resume,
  // don't stack a check-in). A purely reactive comment ("nice") just carries on. Otherwise we
  // ALWAYS check in (rotating the wording) and WAIT — never auto-resume, which felt robotic.
  if (endsWithQuestion(answer)) holdForReply(g);
  else if (isPureComment(text)) resumeOrFinish();
  else await askCheckin(g);
}

// Our spoken answer ended by asking the user something, so hold the floor and wait for their
// reply (with the same gentle escalation) instead of resuming the demo on our own.
function holdForReply(g) {
  if (g !== state.gen || !state.sessionActive) return;
  state.userTurn = true;
  state.waitingFor = "question";
  state.quietBeats = 1; // the answer's own question already served as the first invite
  setMode("listening", "Listening — go ahead");
  rescheduleQuiet();
}

// True if the spoken answer already ends by asking the user something — then a separate
// validation question would just stack a second question on top of it.
function endsWithQuestion(s) {
  return /\?["'”’)\]]*\s*$/.test((s || "").trim());
}

// Post-answer check-in: rotate among three styles (clarity / "anything else?" / "shall I
// continue?") so it never feels canned, REMEMBER which one we asked, and WAIT for the user
// rather than carrying on by ourselves. The chosen style decides how yes/no is read later.
async function askCheckin(g) {
  const style = pickCheckinStyle();
  const q = style === "more" ? pickMore() : style === "confirm" ? pickConfirm() : pickValidation();
  setMode("answering", "…");
  addMsg("Guide", q);
  await speak(q);
  if (g !== state.gen || !state.sessionActive) return;
  state.userTurn = true;
  state.waitingFor = "validation";
  state.checkinStyle = style;
  state.acked = false; // fresh passive-ack budget for this wait
  setMode("listening", style === "clarity" ? "Listening — does that help?" : "Listening — anything else?");
}

async function clarify() {
  const g = bumpGen();
  setMode("answering", "…");
  const q = pickClarify();
  addMsg("Guide", q);
  await speak(q);
  if (g !== state.gen || !state.sessionActive) return;
  state.userTurn = true;
  state.waitingFor = "validation"; // their next utterance is the thing to explain
  state.acked = false; // fresh passive-ack budget for this wait
  setMode("listening", "Listening…");
}

// ---- Resume (recover checkpoint, transition, continue forward) -----------------
async function resumeDemo() {
  if (!state.sessionActive) return;
  endUserTurn();
  const g = bumpGen();
  setMode("answering", "Resuming…");
  await speak(pickTransition());
  if (g !== state.gen || !state.sessionActive) return; // interrupted during the transition
  startRun(); // continues from stepIndex/actionIndex — completed steps/fields are not repeated
}

function resumeOrFinish() {
  endUserTurn();
  if (state.stepIndex >= DEMO.steps.length) enterListening();
  else resumeDemo();
}

// The user closed the conversation ("that's all", "thanks, bye"). Say goodbye ONCE
// and END the session. No validation, no "is that clear?" — a farewell is terminal.
async function farewell() {
  clearTurnTimers();
  state.busy = false;
  state.userTurn = false;
  state.waitingFor = null;
  state.acked = false;
  bumpGen(); // claim the floor for the goodbye, invalidating any in-flight speech
  setMode("answering", "…");
  const bye = pickFarewell();
  addMsg("Guide", bye);
  await speak(bye);
  endSession();
}

// Tear down the session (ear, mic, cursor) and go idle. Used by farewell() and when the brain
// decides the demo is done (the spoken sign-off has already been said by the caller).
function endSession() {
  state.sessionActive = false;
  stopEar();
  releaseMic();
  highlightField(null);
  Human.removeCursor();
  setMode("idle", "Thanks — session ended");
}

// ---- Speech recognition (browser STT + barge-in) ------------------------------
const COMMANDS = {
  next: /^(next|skip|move on|next step|forward)\b/,
  repeat: /^(repeat|say that again|again|one more time)\b/,
  stop: /\b(stop|end demo|end the demo|cancel|that's enough)\b/,
};
// Phrases that, in a Q&A wait, mean "I'm satisfied — carry on".
const RESUME = /^(continue|keep going|carry on|resume|go on|go ahead|never ?mind|no questions?|nothing( else)?)\b/;
// "Carry on" said ANYWHERE in the reply (not just at the start) — covers natural phrasings
// like "everything's fine, continue with the demo" that RESUME (anchored) would miss.
const CONTINUE = /\b(continue|keep going|carry on|go on|move on|proceed|go ahead)\b/;
const APPROVE = /^(yes|yeah|yep|yup|sure|clear|that'?s clear|got it|makes sense|understood|perfect|great|cool|thanks|thank you|ok|okay|alright|fine|i'?m (fine|good|ok|okay)|we'?re (fine|good|ok)|everything'?s? (is )?(fine|good|ok|okay|clear|alright)|all (good|fine|set)|sounds good)\b/;
const CLOSE = /\b(no more|nothing else|no thanks|i'?m good|im good|all good|nothing( more| else)?)\b/;
const DENY = /^(no|nope|not really|not quite|not clear|kind of|sort of|i don'?t (get|understand))\b/;
// A bare affirmative with nothing after it. After an "anything else?" check-in this means
// "yes, I do have more" (invite the question) — NOT "yes, carry on".
const BARE_YES = /^(yes|yeah|yep|yup|sure|i do)[\s.,!?]*$/;
// "I'm satisfied, move on" markers that DON'T start with yes/yeah (so an "anything else?"
// check-in can carry on without mistaking "yes, one more thing…" for it).
const SATISFIED = /^(ok(ay)?|alright|fine|thanks|thank you|that'?s (great|good|perfect|fine|all|it)|great|perfect|cool|lovely|nice|i'?m good|all good|sounds good|got it|no thanks)\b/;
// A goodbye / "we're done" — ends the whole interaction (checked before everything
// else so a farewell never gets routed into the Q&A or validation loop).
const FAREWELL = /\b(bye|goodbye|good bye|see (you|ya)|gotta go|i['’]?m done|we['’]?re done|we'?re good|i['’]?m good for now|good for now|that(?: is|['’]?s) (all|it|everything)( for (now|today|me))?|that(?: is|['’]?s) enough( for (now|today|me))?|that['’]?ll (be all|do)|leave it (here|there)|stop here|(?:we'?ve |i'?ve |you'?ve )?(seen|shown me) (it all|everything|enough)|seen enough|i think (?:that'?s|that is|we'?ve) (it|all|everything|covered (?:it|everything))|let'?s (stop|finish|wrap (?:it |this )?up|call it( a day| here)?)|wrap (?:it|this) up|we can (stop|finish|end|wrap (?:it |this )?up|call it))\b/;
// An explicit request for TIME — the whole utterance is just "hold on / one moment /
// let me think" with nothing else. Anchored to the end so "hold on, what does this do?"
// is NOT treated as a pause (it carries a real question) and falls through to Q&A.
const PAUSE = /^(please\s+)?((wait|hold on|hold up|hang on)|((wait|hold on|hold up|hang on|just|give me|gimme|let me have|lemme have|i(?:'| a)?\s*(?:just\s+)?need)\s+)*(a|one|1|two|2|a couple(?: of)?|a few)\s+(sec(?:ond)?s?|min(?:ute)?s?|moment|bit)|let me (?:think|see|check|have a look|take a look)(?: (?:this|that|it) (?:out|over))?)( please)?[\s.,!?]*$/;
// A pure filler / unfinished opener with NOTHING substantive after it ("um…", "what
// if…", "I have a question"). Anchored to the whole utterance so real questions that
// merely START with one of these ("what if I forget my password?") are NOT caught.
// Polite/filler lead-ins we strip before judging intent ("excuse me, …", "sorry, …").
const PREFIX = /^(?:(?:excuse me|sorry|pardon(?: me)?|hey|hi|hello|um+|uh+|er+|hm+|okay|ok|so|well|actually)[\s,]+)+/;
const INCOMPLETE = /^(u+m+|u+h+|h+m+|e+r+|so|well|okay so|actually|i mean|like|and|but|what if|and if|so if|i(?:'?ve| have| had| got|'?ve got| have got)?\s*(?:a |another )?(?:quick )?questions?|quick question|(?:a )?question(?: for you)?|can i ask(?: you)?(?: something)?|could i ask|may i ask|let me ask)[\s.,!?]*$/;
// True for an announced-but-unasked question or unfinished opener — the WHOLE utterance
// (after any polite prefix) with nothing substantive after it. Anchored so a real question
// that merely starts this way ("what if I forget my password?") is NOT caught.
function isIncomplete(lc) { return INCOMPLETE.test(lc.replace(PREFIX, "")); }
// A purely reactive comment with no doubt in it ("oh nice", "that's clever"). After one
// of these there is nothing to validate, so we just carry on. EVERYTHING else we answered
// is treated as a real doubt, so validation (Estado 3) is mandatory before advancing.
const COMMENT = /^(oh+|ah+|ooh+|wow|hmm+|hey|haha)?[\s,]*(nice|cool|neat|lovely|interesting|amazing|awesome|great|good|right|gotcha|i see|makes sense|fair enough|sounds good|i like (it|that|this)|(that|this|it)('?s| is) (cool|nice|neat|clever|interesting|great|smart|handy|helpful|impressive|useful|good))?[\s.,!]*$/;
function isPureComment(text) {
  return COMMENT.test(text.toLowerCase().trim());
}

function wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

// A short utterance that still carries real intent (a command or a yes/no-style answer),
// so it must NOT be discarded by the noise floor even though it's under 2 words.
function isMeaningfulShort(lc) {
  return COMMANDS.stop.test(lc) || COMMANDS.next.test(lc) || COMMANDS.repeat.test(lc) ||
    FAREWELL.test(lc) || APPROVE.test(lc) || DENY.test(lc) || RESUME.test(lc) || CLOSE.test(lc) ||
    PAUSE.test(lc); // a lone "wait" is a deliberate stop signal, not noise
}

// Voice-driven navigation: "show me communications", "go to the pipeline", "no, take me to
// the dashboard" — or just a bare section name. Lets the user steer the demo to any section.
const NAV_VERB = /\b(go(?: back)? to|goto|show me|show|take me to|open|navigate to|jump to|switch to|bring up|move to|head to|let'?s (?:go to|see|look at)|back to)\b/;
const NAV_SECTIONS = [
  { id: "dashboard", re: /\b(dashboard|home|overview|the numbers|metrics|kpis?)\b/,
    bare: /^(?:the\s+)?(dashboard|home|overview|metrics|kpis?)[\s.!?]*$/ },
  { id: "contacts",  re: /\b(contacts?|people|the list)\b/,
    bare: /^(?:the\s+)?(contacts?|people)[\s.!?]*$/ },
  { id: "pipeline",  re: /\b(pipeline|opportunit(?:y|ies)|deals?|the board|kanban)\b/,
    bare: /^(?:the\s+)?(pipeline|opportunit(?:y|ies)|deals?|kanban|board)[\s.!?]*$/ },
  { id: "comms",     re: /\b(communications?|comms|emails?|messaging|messages|outreach)\b/,
    bare: /^(?:the\s+)?(communications?|comms|emails?|messaging|messages|outreach)[\s.!?]*$/ },
];
// Returns the target section id, or null if this isn't a navigation request. With a nav verb
// ("show me X", "go to X") any section mention counts; without one, only a BARE section name
// ("communications", "the pipeline") does — so "draft an email" / "add a contact" don't jump.
function navTarget(lc) {
  const hasVerb = NAV_VERB.test(lc);
  if (!hasVerb && /\b(what|what'?s|whats|why|how|when|where|who|which|is|are|does|do|tell|explain)\b/.test(lc)) return null;
  for (const s of NAV_SECTIONS) {
    if (!s.re.test(lc)) continue;
    if (hasVerb || s.bare.test(lc)) return s.id;
  }
  return null;
}

// Route a finished user utterance: stop the agent if needed, then command / Q&A / resume.
function handleUtterance(text) {
  const lc = text.toLowerCase();

  // [!] ANTI-ECHO: our own voice coming back through the speaker. Ignore it 100% —
  // never pause, answer, or comment on the "repeat". Assume hardware echo, not the user.
  if (isEcho(text)) return;
  // Noise floor: while we're audible, a sub-2-word fragment with no real meaning is
  // garbled pickup, not input — drop it instead of letting it interrupt.
  if (withinEchoWindow() && wordCount(text) < 2 && !isMeaningfulShort(lc)) return;

  if (isAgentOutputting() && !state.userTurn) onUserBargeIn(); // a final with no prior interim
  clearTurnTimers();
  if (state.busy) return;

  if (COMMANDS.stop.test(lc)) return stopDemo();
  if (FAREWELL.test(lc)) return farewell(); // a goodbye is terminal — never route it into Q&A
  if (COMMANDS.next.test(lc)) return nextStep();
  if (COMMANDS.repeat.test(lc)) return repeatStep();

  // "go to communications", "show me the pipeline", "no, back to the dashboard" — jump there.
  const nav = navTarget(lc);
  if (nav) return goToSection(nav);

  // End of the demo: the user is answering "anything else?". A closing/negative ENDS the
  // session (no more "any other questions?" loop); a real question still gets answered below.
  if (state.stepIndex >= DEMO.steps.length && (CLOSE.test(lc) || DENY.test(lc))) return farewell();

  // Semantic routing while we hold the floor open. A request for TIME gets an empathetic
  // "take your time" (NOT a Q&A invite); an unfinished question opener gets a passive
  // "go ahead". Neither is sent to the brain — listening actively beats guessing.
  // A pure request for time is ALWAYS a "wait" — never a question to answer and never a
  // reason to resume — so honor it whether or not we already hold the floor.
  if (PAUSE.test(lc)) return acceptPause();
  const holding = state.userTurn || state.mode === "listening";
  // An announced-but-unasked question ("I have a question", "um…"): in a validation wait keep
  // the old passive nudge; otherwise invite it and patiently wait (re-ask, then carry on).
  if (holding && isIncomplete(lc)) {
    return state.waitingFor === "validation" ? passiveAck() : promptForQuestion();
  }

  if (state.waitingFor === "validation") {
    const style = state.checkinStyle;
    if (style === "more") {
      // "Anything else?": a bare "yes" = they HAVE more (invite it); no / a closer / a
      // satisfied marker = carry on; anything else (incl. "yes, how do I…") = answer it.
      if (BARE_YES.test(lc)) return promptForQuestion();
      if (DENY.test(lc) || CLOSE.test(lc) || RESUME.test(lc) || CONTINUE.test(lc) || SATISFIED.test(lc)) return resumeOrFinish();
      return answerQuestion(text);
    }
    if (style === "confirm") {
      // "Shall I continue?": yes / continue = carry on; "no / not yet" = they have more.
      if (APPROVE.test(lc) || CONTINUE.test(lc) || RESUME.test(lc) || CLOSE.test(lc)) return resumeOrFinish();
      if (DENY.test(lc)) return promptForQuestion();
      return answerQuestion(text);
    }
    // "clarity" (unchanged): yes = carry on; no = re-explain; else answer the follow-up.
    if (RESUME.test(lc) || CONTINUE.test(lc) || CLOSE.test(lc) || APPROVE.test(lc)) return resumeOrFinish();
    if (DENY.test(lc)) return clarify();
    return answerQuestion(text);
  }

  // "question" phase (interrupted) or open listening.
  if (state.userTurn && (RESUME.test(lc) || CONTINUE.test(lc))) return resumeOrFinish();
  if (wordCount(text) >= 1) return answerQuestion(text);
}

// ---- Shared speech handling (engine-agnostic) ---------------------------------
// Both ears (browser STT and Deepgram) funnel through here: `interim` drives barge-in, a
// non-empty `final` is a completed user utterance to route. This is the ONLY place that
// reacts to speech, so the whole state machine behaves identically whichever ear produced it.
function onSpeech(interim, final) {
  if (!state.sessionActive) return;

  // VAD / barge-in: the moment the user talks while the guide is outputting, stop —
  // UNLESS it's our own voice echoing off the speaker (anti-echo), which we never act on.
  const speaking = !state.busy && wordCount(interim) >= BARGE_MIN_WORDS && !isEcho(interim);
  if (speaking && isAgentOutputting()) {
    // Backstop for echo the AEC let slip: a borderline (2-word) hit must survive a second
    // recognizer update before we cut in, so a one-shot phantom fragment never interrupts.
    // A clearly-real burst (>= BARGE_CONFIRM_WORDS) cuts in immediately, no delay.
    if (state.bargePrimed || wordCount(interim) >= BARGE_CONFIRM_WORDS) onUserBargeIn();
    else state.bargePrimed = true;
  } else if (speaking && state.userTurn && state.waitingFor === "question") {
    rescheduleQuiet(); // post-interruption wait: keep pushing the ack back while they talk
  } else {
    state.bargePrimed = false; // the candidate didn't hold up — reset the debounce
  }

  if (final) handleUtterance(final.trim());
}

// ---- Ear A: browser STT (webkitSpeechRecognition) — fallback when no Deepgram key ----
let browserRec = null;

function setupBrowserRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }
    onSpeech(interim, final);
  };
  // The API stops on its own periodically; restart (with the same AEC track) while live.
  rec.onend = () => { if (state.sessionActive && state.sttEngine === "browser") startBrowserRecognition(rec); };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setMode("idle", "Mic blocked — allow microphone access and reload");
      state.sessionActive = false;
    }
  };
  return rec;
}

// Start the browser recognizer on the echo-cancelled mic track when supported
// (Chrome 139+ accepts start(MediaStreamTrack)); otherwise fall back to the default mic.
function startBrowserRecognition(rec) {
  const track = state.micStream && state.micStream.getAudioTracks()[0];
  if (track && track.readyState === "live") {
    try { rec.start(track); state.aecActive = true; return; } catch {}
  }
  try { rec.start(); } catch {}
}

// ---- Ear B: Deepgram streaming STT, via our same-origin proxy (/api/listen) ----------
// We connect to OUR server (which holds the key and relays to Deepgram), and feed it the
// echo-cancelled mic stream (acquireMic) so Deepgram never hears our own speaker. The STT
// params live server-side; here we just stream audio and consume transcripts.
// Returns true if the socket opened; false means the caller should fall back to the browser.
async function startDeepgramEar() {
  if (!state.sessionActive || !state.micStream) return false;
  if (!window.MediaRecorder) return false; // can't stream audio -> let the browser ear take over

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/api/listen`);
  } catch (e) {
    console.warn("Deepgram proxy socket failed; falling back to the browser ear:", e?.message || e);
    return false;
  }
  state.dgSocket = ws;
  state.dgFinalBuf = "";

  ws.onopen = () => {
    if (!state.sessionActive) { try { ws.close(); } catch {} return; }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "";
    const rec = mime
      ? new MediaRecorder(state.micStream, { mimeType: mime })
      : new MediaRecorder(state.micStream);
    state.dgRecorder = rec;
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(ev.data);
    };
    rec.start(250); // 250ms chunks: low latency without flooding the socket
    // (KeepAlive to Deepgram is handled server-side so silence doesn't drop the stream.)
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "Results") {
      const piece = (msg.channel?.alternatives?.[0]?.transcript || "").trim();
      // Everything said this turn but not yet flushed (accumulated finals + live interim)
      // drives barge-in; the final routing waits for the turn to actually end.
      const inProgress = (state.dgFinalBuf + " " + piece).trim();
      onSpeech(inProgress, "");
      if (piece && msg.is_final) state.dgFinalBuf = (state.dgFinalBuf + " " + piece).trim();
      // NOTE: do NOT flush on speech_final. With endpointing it fires on every short pause,
      // which would split one spoken question into several finals -> several answers (the
      // "two voices" bug). Wait for UtteranceEnd, which marks the real end of the turn.
    } else if (msg.type === "UtteranceEnd") {
      flushDeepgram(); // the user's turn actually ended -> answer the WHOLE question once
    }
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onclose = () => {
    cleanupDeepgramAudio();
    // Unexpected drop mid-session -> reconnect.
    if (state.sessionActive && state.sttEngine === "deepgram" && state.dgSocket === ws) {
      state.dgSocket = null;
      startDeepgramEar();
    }
  };
  return true;
}

function flushDeepgram() {
  const text = state.dgFinalBuf.trim();
  state.dgFinalBuf = "";
  if (text) onSpeech("", text);
}

function cleanupDeepgramAudio() {
  if (state.dgRecorder) { try { state.dgRecorder.stop(); } catch {} state.dgRecorder = null; }
}

function stopDeepgramEar() {
  cleanupDeepgramAudio();
  const ws = state.dgSocket;
  state.dgSocket = null; // clear first so onclose doesn't reconnect
  if (ws) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
    try { ws.close(); } catch {}
  }
  state.dgFinalBuf = "";
}

// ---- Ear lifecycle (engine dispatch) ------------------------------------------
// Try Deepgram first when configured; if anything fails, degrade to the browser ear so
// the demo always has an ear. Returns false only if NO ear could be started at all.
async function startEar() {
  if (state.sttEngine === "deepgram") {
    if (await startDeepgramEar()) return true;
    state.sttEngine = "browser"; // proxy socket failed -> degrade for the rest of the session
    if (els.status) els.status.textContent = "Using browser speech recognition (Deepgram unavailable)";
  }
  browserRec = setupBrowserRecognition();
  if (!browserRec) {
    setMode("idle", "Voice unavailable");
    notify("Couldn't start voice — please use Chrome (or Edge) and allow microphone access, then press Start again.");
    state.sessionActive = false;
    Human.removeCursor(); // don't leave the painted cursor stuck after a failed start
    releaseMic();
    return false;
  }
  startBrowserRecognition(browserRec);
  return true;
}

function stopEar() {
  stopDeepgramEar();
  if (browserRec) { try { browserRec.stop(); } catch {} browserRec = null; }
}

// Capture the mic with the browser's hardware/echo cancellation enabled. This is the
// PRIMARY anti-echo defense: with echoCancellation on, Chrome subtracts the speaker
// output (our TTS) from the mic feed acoustically, BEFORE the recognizer sees it — so
// the agent's own voice over the laptop speakers no longer transcribes as phantom input.
// The text-level isEcho() filter and the barge-in debounce are backstops for residue.
async function acquireMic() {
  if (!navigator.mediaDevices?.getUserMedia) return; // fall back to recognizer's own mic
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    console.warn("Mic capture with echo cancellation failed; using default mic:", e?.message || e);
    state.micStream = null;
  }
}

function releaseMic() {
  if (state.micStream) {
    try { state.micStream.getTracks().forEach((t) => t.stop()); } catch {}
    state.micStream = null;
  }
  state.aecActive = false;
}

// ---- Session control ----------------------------------------------------------
async function startDemo() {
  state.history = [];
  state.stepIndex = 0;
  state.actionIndex = 0;
  state.narrated = false;
  state.visited = {};
  state.sessionActive = true;
  endUserTurn();
  resetForm();
  Human.initCursor(); // paint the cursor that will glide over the form
  rememberPlaceholders();

  // Echo-cancelled capture first — it's fed to whichever ear we use (Deepgram or browser).
  await acquireMic();
  if (!state.sessionActive) return; // user may have stopped while the mic prompt was up
  if (!(await startEar())) return;  // Deepgram if configured, else browser STT (or bail)
  if (!state.sessionActive) return; // ear setup may have failed and ended the session
  if (!state.micStream) {
    // The tour still plays (TTS + the motor), but with no mic we can't hear the user.
    notify("Microphone blocked — the tour will play, but you won't be able to talk to it. Allow the mic and press Start again to interact by voice.");
  }
  startRun();
}

function stopDemo() {
  state.sessionActive = false;
  bumpGen();
  endUserTurn();
  state.busy = false;
  stopAudio();
  stopEar();
  releaseMic(); // free the echo-cancelled capture so the mic indicator clears
  highlightField(null);
  Human.removeCursor();
  setMode("idle", "Stopped");
}

// ---- Wire up ------------------------------------------------------------------
els.startBtn.addEventListener("click", startDemo);
els.continueBtn.addEventListener("click", () => state.sessionActive && resumeDemo());
els.repeatBtn.addEventListener("click", () => state.sessionActive && repeatStep());
els.stopBtn.addEventListener("click", stopDemo);

(async function init() {
  rememberPlaceholders();
  // Which ear to use is decided server-side (Deepgram if a key is configured, else browser).
  try {
    const ear = await (await fetch("/api/ear")).json();
    state.sttEngine = ear.engine === "deepgram" ? "deepgram" : "browser";
    if (ear.model) DG_MODEL = ear.model;
  } catch {
    state.sttEngine = "browser"; // default to the always-available browser ear
  }
  try {
    DEMO = await (await fetch("/api/demo")).json();
    setMode("idle", "Ready — press Start demo");
  } catch {
    setMode("idle", "Could not load demo script");
  }
})();
