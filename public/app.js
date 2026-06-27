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
  nextBtn: document.getElementById("nextBtn"),
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
  acked: false,       // have we already acknowledged this interruption?
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
const BARGE_MIN_WORDS = 2;      // VAD floor: ignore <2-word fragments (noise / garbled pickup)
const BARGE_CONFIRM_WORDS = 3;  // >= this many words cuts in instantly; 2 words must persist a tick
const STEP_GAP = 800;           // pause between steps
const ECHO_TAIL_MS = 1200;      // keep filtering echo this long after audio stops (STT lag)
const ECHO_MIN_RUN = 3;         // a verbatim run of >= this many of OUR words back == speaker echo

const ACKS = [
  "Sure, go ahead.",
  "I'm listening.",
  "Go ahead with your question.",
  "Of course — tell me.",
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
// Empathetic reaction when the user just asks for a moment — accept the pause and wait.
// Deliberately NOT phrased as "go ahead, ask me": they asked for time, not an invitation.
const PAUSES = [
  "Sure, take your time.",
  "Of course — no rush.",
  "Take your time, I'm here.",
  "No problem, I'll wait.",
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
const pickClarify = makeRotator(CLARIFIES);
const pickTransition = makeRotator(TRANSITIONS);
const pickFarewell = makeRotator(FAREWELLS);
const pickPause = makeRotator(PAUSES);

const randInt = (lo, hi) => Math.floor(lo + Math.random() * (hi - lo + 1));

// ---- UI helpers ---------------------------------------------------------------
function setMode(mode, statusText) {
  state.mode = mode;
  els.orb.className = "orb " + (mode === "idle" ? "idle" : mode);
  els.status.textContent = statusText || mode;
  els.nextBtn.disabled = !state.sessionActive;
  els.repeatBtn.disabled = !state.sessionActive;
  els.stopBtn.disabled = !state.sessionActive;
  els.startBtn.disabled = state.sessionActive;
}

function addMsg(who, text) {
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

function highlightField(fieldId) {
  document.querySelectorAll(".highlight").forEach((e) => e.classList.remove("highlight"));
  if (fieldId) document.getElementById(fieldId)?.classList.add("highlight");
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
      els.status.textContent = "No voice: " + reason;
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

async function runSteps(g) {
  while (alive(g) && state.stepIndex < DEMO.steps.length) {
    const step = DEMO.steps[state.stepIndex];
    highlightField(step.field);

    // Narration: re-narrated only if it was never completed (interrupted mid-sentence).
    if (!state.narrated) {
      addMsg("Guide", step.narration);
      setMode("narrating", `Step ${state.stepIndex + 1}/${DEMO.steps.length}`);
      await speak(step.narration);
      if (!alive(g)) return; // interrupted -> narrated stays false, re-narrate on resume
      state.narrated = true;
    }

    // Actions: run only the not-yet-completed ones. A completed action's index is
    // advanced and NEVER revisited (strict, one-way progress — no refilling fields).
    const actions = step.actions || (step.action ? [step.action] : []);
    while (state.actionIndex < actions.length) {
      if (!alive(g)) return;
      await runAction(actions[state.actionIndex]);
      if (!alive(g)) return; // interrupted mid-action -> keep index, re-run just this one
      state.actionIndex++;
    }

    // Step fully done -> advance the checkpoint to the next step.
    state.stepIndex++;
    state.actionIndex = 0;
    state.narrated = false;
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

async function runAction(action) {
  if (action.type === "type") {
    const el = document.getElementById(action.field);
    if (el) await Human.type(el, action.value, { keepGoing, think: action.think });
  } else if (action.type === "pick") {
    await Human.pick("#" + action.field, action.value, { keepGoing });
  } else if (action.type === "check") {
    const input = document.getElementById(action.field);
    const label = input && input.closest("label");
    if (label && !input.checked) await Human.click(label, { keepGoing });
  } else if (action.type === "click") {
    const el = document.getElementById(action.field);
    if (el) await Human.click(el, { keepGoing, pause: 0.4 });
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

// ---- Interruption handling (empathetic, infinite-wait turn-taking) ------------
// (Re)start the "user has gone quiet" countdown: only after they pause for ACK_DELAY
// do we acknowledge — and only once. Called again on each word so we never cut in early.
function rescheduleQuiet() {
  if (state.acked || state.waitingFor !== "question") return;
  clearTurnTimers();
  const g = state.gen;
  state.ackTimer = setTimeout(() => onAckTimeout(g), randInt(ACK_DELAY[0], ACK_DELAY[1]));
}

// The user took the floor (barged in over the agent): stop, snapshot is already kept in
// stepIndex/actionIndex/narrated, invalidate in-flight speech, then wait — indefinitely.
function onUserBargeIn() {
  state.userTurn = true;
  state.waitingFor = "question";
  state.acked = false;
  state.bargePrimed = false;              // we committed — clear the debounce
  bumpGen();                              // invalidate in-flight answer/ack/transition awaits
  stopAudio();                            // VAD: never talk over the user
  setMode("listening", "I'm listening…"); // also flips driving() off, so the form-fill bails
  rescheduleQuiet();
}

// Fires only if the user interrupted but then said nothing yet: acknowledge once, then
// wait forever for the real question (NO timeout-based resume).
async function onAckTimeout(g) {
  if (g !== state.gen || !state.sessionActive || state.waitingFor !== "question" || state.acked) return;
  setMode("answering", "…");
  await speak(pickAck());
  if (g !== state.gen || !state.sessionActive) return;
  state.acked = true;
  setMode("listening", "Listening — go ahead");
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

// An unfinished opener ("um…", "what if…", "I have a question"). Invite them to finish.
function passiveAck() {
  const msg = state.waitingFor === "validation" ? "Listening — does that help?" : "Listening — go ahead";
  return passiveHold(pickAck, msg);
}

// An explicit request for TIME ("hold on", "one moment", "let me think"). The right
// human reaction is to accept the pause — NOT to invite a question or validate anything.
function acceptPause() {
  return passiveHold(pickPause, "Listening — take your time");
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
  try {
    const r = await fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: text,
        stepIndex: state.stepIndex,
        history: state.history.slice(-6),
      }),
    });
    const data = await r.json();
    if (data.text) answer = data.text;
    checkIn = !!data.checkIn;
  } catch (e) {
    console.error(e);
  }
  state.busy = false;
  if (g !== state.gen || !state.sessionActive) return; // a newer interruption superseded this

  state.history.push({ role: "assistant", content: answer });
  addMsg("Guide", answer);
  setMode("answering", "Answering…");
  await speak(answer); // interruptible: the user can ask a follow-up over the answer
  if (g !== state.gen || !state.sessionActive) return;

  // Validation is now CONDITIONAL, not mandatory — the brain decides per answer whether a
  // closing check helps (checkIn), so we don't interrogate the user every single turn. We
  // skip the check (and just carry on) when: it was a reactive comment with no doubt to
  // resolve, OR the answer already ends by asking the user something (asking again would
  // stack two questions), OR the brain judged a check-in wouldn't add anything.
  if (isPureComment(text) || endsWithQuestion(answer) || !checkIn) resumeOrFinish();
  else await askValidation(g);
}

// True if the spoken answer already ends by asking the user something — then a separate
// validation question would just stack a second question on top of it.
function endsWithQuestion(s) {
  return /\?["'”’)\]]*\s*$/.test((s || "").trim());
}

async function askValidation(g) {
  setMode("answering", "…");
  const q = pickValidation();
  addMsg("Guide", q);
  await speak(q);
  if (g !== state.gen || !state.sessionActive) return;
  state.userTurn = true;
  state.waitingFor = "validation";
  state.acked = false; // fresh passive-ack budget for this wait
  setMode("listening", "Listening — does that help?");
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
  // The conversation is over regardless of how the goodbye ended — close everything out.
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
// A goodbye / "we're done" — ends the whole interaction (checked before everything
// else so a farewell never gets routed into the Q&A or validation loop).
const FAREWELL = /\b(bye|goodbye|good bye|see (you|ya)|gotta go|i['’]?m done|we['’]?re done|that(?: is|['’]?s) (all|it|everything)|that['’]?ll be all)\b/;
// An explicit request for TIME — the whole utterance is just "hold on / one moment /
// let me think" with nothing else. Anchored to the end so "hold on, what does this do?"
// is NOT treated as a pause (it carries a real question) and falls through to Q&A.
const PAUSE = /^(wait|hold on|hang on( a (sec|second|moment))?|one (sec(ond)?|moment|minute)|just a (sec(ond)?|moment|minute)|give me a (sec(ond)?|moment|minute)|gimme a (sec(ond)?|moment)|a (sec(ond)?|moment|minute)|let me (think|see|check)( (this|that|it) (out|over))?)( please)?[\s.,!?]*$/;
// A pure filler / unfinished opener with NOTHING substantive after it ("um…", "what
// if…", "I have a question"). Anchored to the whole utterance so real questions that
// merely START with one of these ("what if I forget my password?") are NOT caught.
const INCOMPLETE = /^(u+m+|u+h+|h+m+|e+r+|so|well|okay so|actually|i mean|like|and|but|what if|and if|so if|i have (a|another) question|i'?ve got a question|quick question|can i ask( something| you)?|may i ask|let me ask)[\s.,!?]*$/;
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

  // End of the demo: the user is answering "anything else?". A closing/negative ENDS the
  // session (no more "any other questions?" loop); a real question still gets answered below.
  if (state.stepIndex >= DEMO.steps.length && (CLOSE.test(lc) || DENY.test(lc))) return farewell();

  // Semantic routing while we hold the floor open. A request for TIME gets an empathetic
  // "take your time" (NOT a Q&A invite); an unfinished question opener gets a passive
  // "go ahead". Neither is sent to the brain — listening actively beats guessing.
  const holding = state.userTurn || state.mode === "listening";
  if (holding && PAUSE.test(lc)) return acceptPause();
  if (holding && INCOMPLETE.test(lc)) return passiveAck();

  if (state.waitingFor === "validation") {
    if (RESUME.test(lc) || CONTINUE.test(lc) || CLOSE.test(lc) || APPROVE.test(lc)) return resumeOrFinish();
    if (DENY.test(lc)) return clarify();
    return answerQuestion(text); // a follow-up question -> answer, then validate again
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
    els.status.textContent = "Using browser speech recognition (Deepgram unavailable)";
  }
  browserRec = setupBrowserRecognition();
  if (!browserRec) {
    setMode("idle", "This browser has no Speech Recognition — use Chrome or Edge");
    state.sessionActive = false;
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
els.nextBtn.addEventListener("click", () => state.sessionActive && nextStep());
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
