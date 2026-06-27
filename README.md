# Karumi Voice Demo Guide

An interactive **voice** demo guide. It narrates a product demo step by step, and the
user can **interrupt by speaking at any time** to ask a question — the guide pauses,
answers briefly, then resumes from where it left off.

- **Brain:** Claude API (answers questions, in character, English only, brief).
- **Voice:** ElevenLabs streaming TTS (narration + answers).
- **Ears + barge-in:** the browser's Web Speech API (free, low-latency STT) — this is
  what makes real-time interruption feel instant.

## How it works

```
Browser (mic + speech recognition + audio playback)
   │  user speaks  ──► barge-in: stop narration
   │  question     ──► POST /api/answer ─► Claude  ─► answer text
   │  any text     ──► GET  /api/tts    ─► ElevenLabs ─► MP3 (streamed, played progressively)
   ▼
Node/Express server (server.js)
```

The demo content lives in `demo-script.js`: each step has the **narration** (spoken)
and **context** (fed to Claude so Q&A answers stay on-topic). Edit that one file to
change the demo.

## Run it

1. Install deps:
   ```bash
   npm install
   ```
2. Create your env file and add keys:
   ```bash
   cp .env.example .env
   # edit .env: ANTHROPIC_API_KEY and ELEVENLABS_API_KEY are required
   ```
3. Start:
   ```bash
   npm start
   ```
4. Open **http://localhost:3000** in **Chrome or Edge** (Web Speech API needed),
   click **Start demo**, allow the microphone, and **use headphones** so the guide
   doesn't transcribe its own voice.

Say "next" to advance, "repeat" to repeat, "stop" to end — or just ask a question.

## Latency knobs

This is a voice loop, so latency is everything. The fastest config:

```env
CLAUDE_MODEL=claude-haiku-4-5
ELEVENLABS_MODEL=eleven_flash_v2_5
```

Default is `claude-opus-4-8` (smarter, a bit slower). Switch to Haiku for the snappiest
back-and-forth — it's more than capable for short demo Q&A.

## Notes / known limits

- **Browser STT** (Web Speech API) works in Chrome/Edge; not Firefox/Safari. For a
  production setup, swap it for a streaming STT API.
- **Echo:** without headphones the mic can hear the guide and trigger false barge-ins.
  We require ≥2 spoken words to trigger an interruption, but headphones are the real fix.
- **Upgrade path:** if you want production-grade turn-taking and barge-in without
  managing it yourself, ElevenLabs **Conversational AI (Agents)** can run the whole
  voice loop with Claude wired in as a custom LLM. This project keeps the raw
  Claude + ElevenLabs APIs so you control every piece.
