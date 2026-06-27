import "dotenv/config";
import express from "express";
import http from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { DEMO } from "./demo-script.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config (override via .env) ------------------------------------------------
const PORT = process.env.PORT || 3000;
// Default to Opus 4.8 (most capable). For a live voice loop where latency is the
// hard constraint, switching CLAUDE_MODEL=claude-haiku-4-5 is a big speed/cost win
// and is plenty smart for short demo Q&A — try it if responses feel slow.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — exists on every account
// eleven_flash_v2_5 = lowest latency (~75ms), ideal for a voice agent. Bump to
// eleven_turbo_v2_5 or eleven_multilingual_v2 for higher quality if latency allows.
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
// Deepgram is the "ear" (streaming STT). Optional: if unset, the browser falls back to
// its own webkitSpeechRecognition. The browser never sees this key — it only ever gets a
// 30-second temporary token minted from it (see /api/listen-token).
const DEEPGRAM_KEY = process.env.DEEPGRAM_KEY;
// Nova-3 by default; override per the Deepgram model list if you want.
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
// Flipped to "browser" below if DEEPGRAM_KEY is set but the 'ws' package isn't installed.
let earEngine = DEEPGRAM_KEY ? "deepgram" : "browser";

if (!ANTHROPIC_API_KEY) console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/answer will fail.");
if (!ELEVENLABS_API_KEY) console.warn("⚠  ELEVENLABS_API_KEY is not set — /api/tts will fail.");
if (!DEEPGRAM_KEY) console.warn("ℹ  DEEPGRAM_KEY is not set — the ear falls back to the browser's speech recognition.");

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Expose the demo script to the frontend so narration text lives in one place.
app.get("/api/demo", (_req, res) => res.json(DEMO));

// Tell the frontend which "ear" to use: Deepgram (key configured AND 'ws' available) or browser.
app.get("/api/ear", (_req, res) =>
  res.json({ engine: earEngine, model: DEEPGRAM_MODEL })
);

// ---- Brain: answer a user's question, in character -----------------------------
//
// Builds a system prompt that encodes the spec: spoken English only, conversational,
// non-technical, brief (voice latency), and anchored to the CURRENT demo step so the
// answer keeps the demo context during Q&A.
function buildSystemPrompt(step) {
  return [
    "You are a friendly human-sounding product demo guide. You speak, you are not a chatbot.",
    "",
    "STRICT RULES:",
    "- English ONLY. Never switch to Spanish or any other language, even if asked.",
    "- Sound like a helpful human guide, not a manual. Warm and conversational.",
    "- NO technical jargon. Explain things the way a person would to a non-technical friend.",
    "- Keep it BRIEF: at most 1-2 short sentences. This is spoken aloud, so long answers add latency and lose the listener.",
    "- Answer the user's question directly. Do NOT re-read the step instructions or add preamble.",
    "- Output ONLY the words to be spoken. No stage directions, no markdown, no notes about your reasoning.",
    "- Put ONLY your answer in `text`. Do NOT tack on a closing check like \"does that make sense?\" or \"any other questions?\" — that is decided separately via the `checkIn` field.",
    "- If the question is unrelated or you don't know, say so briefly and offer to continue the demo.",
    "- If the message is cut off or unfinished (e.g. \"and what about…\"), do NOT guess what they meant. Ask them to finish the thought in a few words.",
    "",
    `WHAT IS BEING DEMOED: ${DEMO.product}`,
    "",
    `THE USER IS CURRENTLY ON THIS STEP: "${step.narration}"`,
    `BACKGROUND FOR THIS STEP (use it to answer, do not read it out): ${step.context}`,
    "",
    "After you answer, the demo will resume from this same step, so you don't need to tell them what to do next.",
  ].join("\n");
}

// The brain answers through this single tool (forced via tool_choice) so we get a typed
// { text, checkIn } back instead of free-form text — no risk of a JSON wrapper leaking into
// the spoken audio. `checkIn` lets the model judge, per answer, whether a short spoken
// "does that make sense?" actually helps, instead of the client tacking one on every time.
const REPLY_TOOL = {
  name: "reply",
  description: "Give the spoken reply to the user, and decide whether to follow it with a brief check-in.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The words to speak aloud — your answer only, 1-2 short sentences, no closing check.",
      },
      checkIn: {
        type: "boolean",
        description:
          "Whether a brief spoken check-in (\"does that make sense?\") should follow. Set TRUE only when " +
          "your answer covers something the user might still find confusing and a quick confirmation helps. " +
          "Set FALSE when you fully resolved it, when it was trivial/obvious, or when your text already ends " +
          "by asking the user something.",
      },
    },
    required: ["text", "checkIn"],
  },
};

app.post("/api/answer", async (req, res) => {
  try {
    const { question, stepIndex = 0, history = [] } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "Missing 'question'." });
    }
    const step = DEMO.steps[Math.max(0, Math.min(stepIndex, DEMO.steps.length - 1))];

    // Keep only the last few turns for context — short history keeps latency low.
    const trimmed = history.slice(-6).filter((m) => m && m.role && m.content);

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300, // answers are short; this is a safety ceiling, not a target
      // No `thinking` block: this is a fast, simple Q&A turn and thinking would add
      // latency. Forcing the `reply` tool keeps Opus 4.8 from leaking reasoning into the
      // visible answer and gives us the typed { text, checkIn } in one round-trip.
      system: buildSystemPrompt(step),
      tools: [REPLY_TOOL],
      tool_choice: { type: "tool", name: "reply" },
      messages: [...trimmed, { role: "user", content: question }],
    });

    // Forced tool_choice => the reply comes back as a tool_use block. Fall back to any
    // text block (and a safe checkIn=false) on the off chance the shape isn't as expected.
    const tool = msg.content.find((b) => b.type === "tool_use");
    let text = (tool?.input?.text || "").trim();
    let checkIn = !!tool?.input?.checkIn;
    if (!text) {
      text = msg.content.find((b) => b.type === "text")?.text?.trim() ?? "";
      checkIn = false;
    }
    res.json({ text, checkIn });
  } catch (err) {
    console.error("answer error:", err?.message || err);
    res.status(500).json({ error: "answer_failed", detail: err?.message });
  }
});

// ---- CRM feature: AI-drafted follow-up email -----------------------------------
//
// The Communications screen of the demo CRM calls this to draft a real email for a
// (made-up) contact. Like /api/answer, the output is forced through a typed tool so we
// get clean { subject, body } back instead of free-form text with a greeting/sign-off
// leaking into the wrong field.
const DRAFT_TOOL = {
  name: "email",
  description: "Return a drafted sales email as a subject line and a body.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "A concise, specific subject line (no more than ~8 words)." },
      body: {
        type: "string",
        description:
          "The email body as plain text. Short and warm (about 4-7 lines): a greeting, one or " +
          "two sentences of substance for this contact, a clear next step, and a sign-off. Use " +
          "real line breaks between paragraphs. Sign off as 'The Pipeline CRM team'.",
      },
    },
    required: ["subject", "body"],
  },
};

app.post("/api/draft", async (req, res) => {
  try {
    const { contact = {}, type = "Follow-up" } = req.body || {};
    const name = (contact.name || "there").toString().slice(0, 80);
    const company = (contact.company || "").toString().slice(0, 80);
    const status = (contact.status || "Lead").toString().slice(0, 40);

    const system = [
      "You write short, friendly, professional B2B sales emails for a CRM.",
      "Keep it concise and human — no clichés, no fluff, no markdown.",
      "Address the person by their first name. Make the email fit the email type and the",
      "contact's pipeline stage. Output ONLY through the `email` tool.",
    ].join("\n");

    const prompt =
      `Draft a "${type}" email to ${name}` +
      (company ? ` at ${company}` : "") +
      `. Their current stage in our pipeline is "${status}". ` +
      "Make it specific enough to feel personal, but it's fine to keep the substance light " +
      "since this is sample data.";

    const msg = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system,
      tools: [DRAFT_TOOL],
      tool_choice: { type: "tool", name: "email" },
      messages: [{ role: "user", content: prompt }],
    });

    const tool = msg.content.find((b) => b.type === "tool_use");
    const subject = (tool?.input?.subject || "").trim();
    const body = (tool?.input?.body || "").trim();
    if (!subject && !body) return res.status(502).json({ error: "empty_draft" });
    res.json({ subject, body });
  } catch (err) {
    console.error("draft error:", err?.message || err);
    res.status(500).json({ error: "draft_failed", detail: err?.message });
  }
});

// ---- Voice: text -> speech, streamed back as MP3 -------------------------------
//
// GET (not POST) so the browser <audio> element can point straight at it and play
// the MP3 progressively as bytes arrive — lower perceived latency, less code.
app.get("/api/tts", async (req, res) => {
  const text = (req.query.text || "").toString().slice(0, 1500);
  if (!text) return res.status(400).send("Missing 'text'.");

  try {
    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream` +
      `?output_format=mp3_44100_128`;

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY || "",
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      console.error("tts upstream error:", upstream.status, detail);
      // Echo the real ElevenLabs reason so a curl / the client can show it.
      return res.status(502).send(`ElevenLabs ${upstream.status}: ${detail.slice(0, 300)}`);
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.error("tts error:", err?.message || err);
    res.status(500).send("tts_failed");
  }
});

// ---- Ear: Deepgram streaming STT proxy -----------------------------------------
//
// The browser opens a WebSocket to US (/api/listen) and streams echo-cancelled audio.
// We relay it to Deepgram over a socket authenticated with the real key — which NEVER
// leaves the server (the browser only ever talks to same-origin). Deepgram's transcripts
// are relayed straight back. This sidesteps temporary tokens entirely (the key just needs
// transcription permission, not token-grant permission).
const server = http.createServer(app);

// 'ws' is loaded dynamically so the server still boots (with the browser ear) if it isn't
// installed yet — run `npm install ws` to enable the Deepgram proxy.
let WebSocketServer, WS;
if (DEEPGRAM_KEY) {
  try {
    ({ WebSocketServer, WebSocket: WS } = await import("ws"));
  } catch {
    earEngine = "browser";
    console.warn("⚠  DEEPGRAM_KEY is set but 'ws' is not installed — run `npm install ws`. Using browser STT for now.");
  }
}

if (DEEPGRAM_KEY && WebSocketServer) {
  const wss = new WebSocketServer({ server, path: "/api/listen" });
  wss.on("connection", (client) => {
    const params = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      language: "en-US",
      interim_results: "true",  // instant partials for barge-in
      smart_format: "true",
      endpointing: "300",       // 300ms silence ends a segment
      utterance_end_ms: "1000", // UtteranceEnd after 1s silence (robust turn-end)
      vad_events: "true",
    });
    const dg = new WS("wss://api.deepgram.com/v1/listen?" + params, {
      headers: { Authorization: "Token " + DEEPGRAM_KEY },
    });

    let dgOpen = false;
    const queue = []; // audio arriving before the upstream is ready (incl. the webm header)
    // Hold the upstream open through silence so Deepgram doesn't drop it mid-demo.
    const keepAlive = setInterval(() => {
      if (dgOpen && dg.readyState === WS.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" }));
    }, 8000);

    dg.on("open", () => {
      dgOpen = true;
      for (const chunk of queue) dg.send(chunk);
      queue.length = 0;
    });
    dg.on("message", (data) => {
      if (client.readyState === WS.OPEN) client.send(data.toString()); // JSON transcripts
    });
    dg.on("close", () => { clearInterval(keepAlive); try { client.close(); } catch {} });
    dg.on("error", (e) => {
      console.error("deepgram ws error:", e?.message || e);
      try { client.close(); } catch {}
    });

    client.on("message", (data, isBinary) => {
      if (dgOpen && dg.readyState === WS.OPEN) dg.send(data);
      else if (isBinary) queue.push(data); // don't lose the leading webm chunks before open
    });
    client.on("close", () => {
      clearInterval(keepAlive);
      try { if (dg.readyState === WS.OPEN) dg.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      try { dg.close(); } catch {}
    });
    client.on("error", () => { try { dg.close(); } catch {} });
  });
}

server.listen(PORT, () => {
  console.log(`▶ Karumi voice demo running at http://localhost:${PORT}`);
  console.log(`  brain: ${CLAUDE_MODEL}  |  voice: ElevenLabs ${ELEVEN_MODEL} (${ELEVEN_VOICE_ID})`);
  console.log(`  ear:   ${earEngine === "deepgram" ? "Deepgram " + DEEPGRAM_MODEL + " (proxied)" : "browser STT"}`);
});
