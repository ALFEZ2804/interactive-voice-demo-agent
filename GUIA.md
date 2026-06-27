# Guía completa — Karumi Voice Demo Guide

Manual para entender, reconstruir desde cero y mantener este proyecto **sin tropezar con
los mismos errores que ya salieron**. Está pensado para que puedas montar un proyecto así
partiendo de una carpeta vacía.

Índice:
1. Qué es esto
2. El brief original
3. Leyendo entre líneas: los requisitos que fueron apareciendo
4. Arquitectura y el porqué de cada decisión
5. Crear el proyecto desde 0 (paso a paso, con todos los archivos)
6. Catálogo de errores y su solución
7. Chuleta de diagnóstico (comandos)
8. Adaptar a otra demo
9. Checklist de arranque (TL;DR)
10. Mejoras y vía de producción

---

## 1. Qué es esto

Una **guía de demo por voz**. Al pulsar *Start*:
- Narra una demo paso a paso (en inglés, voz de ElevenLabs).
- **Rellena el formulario ella sola** (escribe el nombre, el email, elige plan, pulsa enviar).
- Avanza sola de un paso al siguiente.
- **Puedes interrumpirla hablando en cualquier momento** para preguntar: se pausa, responde
  breve (con Claude), y reanuda desde el mismo paso. Esto es el "Core Feature": barge-in.

Stack: **Claude API** (cerebro que responde el Q&A) + **ElevenLabs** (voz) +
**Web Speech API del navegador** (oído / detección de interrupción). Backend Node + Express,
frontend vanilla.

---

## 2. El brief original

El punto de partida fue este spec (formato de prompt para el agente de voz):

```text
[R] Interactive Voice Demo Guide
[L] English ONLY
[Tone] Conversational | Non-technical | Helpful human

[T] Execute demo narration :: Guide user step-by-step
-> Example flow: "Now, we need to fill in the name, then the email address..."

[!] Core Feature: Real-time Interactivity
-> Listen for user interruption (Voice input)
-> IF user asks question -> Pause demo narration -> Answer clearly/briefly based on
   current demo context -> Resume demo from paused step.

[C]
- NO technical jargon (explain like a human guide).
- NO long monologues (keep responses brief for voice latency).
- Maintain demo context during Q&A.
- Never switch to Spanish; strict English adherence.

[Output]
Spoken-style text | Short sentences | Wait for user triggers if interactive mode active.
```

Ese spec describe **el comportamiento del agente**, y acabó traducido casi literalmente al
*system prompt* que usa Claude (ver `buildSystemPrompt` en `server.js`).

---

## 3. Leyendo entre líneas: los requisitos que fueron apareciendo

El spec por sí solo no bastaba para construir la app. Estos requisitos efectivos salieron de
las decisiones e iteraciones, y son los que de verdad definen el producto:

1. **No era un prompt, era una app funcional.** Al elegir "implementación/código" y el stack
   "Claude + ElevenLabs", el entregable pasó a ser código que corre, no un prompt pulido.

2. **El barge-in manda la arquitectura.** El "Core Feature" (interrumpir → pausar → responder
   → reanudar) es lo más difícil y arriesgado. Todo se diseñó alrededor de que eso fuera
   instantáneo (de ahí usar el STT del navegador, no una API externa — ver §4).

3. **Latencia por encima de todo.** "keep responses brief for voice latency" + "NO long
   monologues" implican: respuestas cortas, modelo rápido como opción (Haiku), *thinking*
   desactivado, y TTS en streaming. La latencia no es un detalle, es un requisito.

4. **La guía debe RELLENAR el formulario sola, no solo narrarlo.** Esto NO estaba escrito.
   La primera versión solo narraba ("escribe tu nombre…") y resaltaba el campo, esperando que
   el usuario escribiera y dijera "next". Tu expectativa al pulsar *Start* era que la demo se
   rellenara sola. Era tu modelo mental de "demo": el guía *demuestra* haciendo, no solo
   describiendo. → Se añadió auto-rellenado + auto-avance (`action` por paso, `typeInto`).

5. **Los fallos tienen que verse.** Cuando "no sonaba la voz", el error se tragaba en silencio
   y parecía que no pasaba nada. Lección: en un pipeline con piezas externas (claves, APIs), un
   fallo debe ser visible en pantalla y en el log, nunca silencioso.

6. **Configuración real = la mitad del trabajo.** La mayoría de "bugs" no eran de código, sino
   de entorno: faltaba `.env`, clave inválida, formato de la clave. Documentarlo es parte del
   producto (ver §6).

Requisitos efectivos, resumidos:

- Inglés siempre, tono humano, sin jerga, respuestas de 1-2 frases.
- La guía narra **y ejecuta** cada paso sobre un formulario real, y auto-avanza.
- Interrupción por voz en tiempo real, con reanudación desde el paso pausado.
- Mantener el contexto del paso actual durante el Q&A.
- Baja latencia como prioridad de diseño.
- Errores visibles y configuración bien documentada.

---

## 4. Arquitectura y el porqué de cada decisión

```
Navegador (Chrome/Edge)
  ├─ Micrófono + Web Speech API ─► detecta que hablas (resultados parciales) ─► BARGE-IN
  ├─ <audio> ◄──────────────── GET /api/tts ──► ElevenLabs ──► MP3 (streaming)
  └─ pregunta ─────────────── POST /api/answer ─► Claude ──► texto de respuesta
        │
        ▼
  Servidor Node/Express (server.js)
```

**Por qué Claude para el cerebro y ElevenLabs solo para la voz.** Claude responde las
preguntas en personaje; ElevenLabs convierte texto en voz. Son piezas independientes y
reemplazables.

**Por qué el STT (oído) es del navegador y no una API externa.** El barge-in necesita detectar
el *inicio* del habla en milisegundos y con resultados *interim* (parciales). La Web Speech API
da eso gratis y local. Mandar audio a una API de STT añade un round-trip que rompe justo la
sensación de "interrumpir en vivo". Por eso ElevenLabs se reserva para el TTS (donde aporta
calidad) y el oído lo pone el navegador.

**Por qué `/api/tts` es GET y no POST.** Así el elemento `<audio>` del navegador puede apuntar
directamente a la URL y reproducir el MP3 **según van llegando los bytes** (streaming
progresivo). Menos latencia percibida y menos código que con POST + blob.

**Por qué `thinking` está desactivado en `/api/answer`.** Es un Q&A corto y el *thinking*
añadiría segundos de latencia. La regla "Output ONLY the words to be spoken" en el system
prompt evita que el modelo filtre razonamiento en la respuesta visible.

**Por qué el modelo es configurable.** Por defecto `claude-opus-4-8` (el más capaz). Pero en un
bucle de voz, donde la latencia es el requisito, `claude-haiku-4-5` es más rápido y barato y de
sobra capaz para un Q&A de demo. Se cambia con la variable `CLAUDE_MODEL`, sin tocar código.

**Máquina de estados (frontend).** Cuatro modos: `idle` → `narrating` (narra y/o teclea, micro
abierto) → `answering` (te interrumpió, responde) → vuelve a `narrating`. El barge-in solo
dispara cuando el modo es `narrating` y oye ≥2 palabras (para no auto-interrumpirse con su
propia voz; ver eco en §6).

---

## 5. Crear el proyecto desde 0

### 5.1 Prerrequisitos

- **Node 18 o superior** (probado con Node 24). `node --version`.
- **Cuenta de Anthropic** + API key → https://console.anthropic.com → *API Keys*.
- **Cuenta de ElevenLabs** + API key → https://elevenlabs.io → menú de tu perfil → *API Keys*.
  Créala con **acceso completo / sin restricciones** (evita errores de permisos al usar TTS) y
  **copia la clave entera en el momento de crearla** (solo se muestra una vez). El plan gratuito
  basta para probar.
- Navegador **Chrome o Edge** (la Web Speech API no está en Firefox/Safari).

### 5.2 Estructura final

```text
karumi-voice-demo/
├── .env                 (lo creas tú; NO se commitea)
├── .env.example
├── .gitignore
├── package.json
├── server.js            backend Express: /api/demo, /api/answer (Claude), /api/tts (ElevenLabs)
├── demo-script.js       el contenido de la demo (pasos: narración + acción + contexto)
├── public/
│   ├── index.html       formulario simulado (el "producto") + panel de la guía
│   ├── styles.css
│   └── app.js           máquina de estados, voz, barge-in, auto-rellenado
├── GUIA.md              esta guía
├── README.md
└── CLAUDE.md            contexto para Claude Code
```

### 5.3 Comandos iniciales

```bash
mkdir karumi-voice-demo && cd karumi-voice-demo
mkdir public
npm init -y
npm install @anthropic-ai/sdk dotenv express
```

(Luego ajusta `package.json` para que tenga `"type": "module"` y los scripts; ver abajo.)

### 5.4 Los archivos (contenido completo)

#### `package.json`

```json
{
  "name": "karumi-voice-demo",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Interactive voice demo guide (Claude API brain + ElevenLabs voice) with real-time barge-in",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.69.0",
    "dotenv": "^17.2.3",
    "express": "^5.1.0"
  }
}
```

> `"type": "module"` es necesario porque todo el código usa `import`/`export` (ESM).

#### `.gitignore`

```text
node_modules/
.env
*.log
.DS_Store
```

#### `.env.example`

```text
# Copy to .env and fill in. Never commit .env.

# --- Claude (the brain) ---
ANTHROPIC_API_KEY=sk-ant-...
# claude-opus-4-8 (default, most capable) | claude-haiku-4-5 (fastest, best for low-latency voice)
CLAUDE_MODEL=claude-opus-4-8

# --- ElevenLabs (the voice) ---
ELEVENLABS_API_KEY=...
# Default "Rachel" voice (exists on every account). Pick any voice ID from your ElevenLabs library.
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
# eleven_flash_v2_5 (lowest latency) | eleven_turbo_v2_5 | eleven_multilingual_v2 (highest quality)
ELEVENLABS_MODEL=eleven_flash_v2_5

# --- Server ---
PORT=3000
```

#### `demo-script.js`

El **único archivo que tocas para cambiar la demo**. Cada paso: `narration` (lo que dice),
`action` (lo que hace en el formulario) y `context` (lo que Claude usa para responder dudas
sobre ese paso).

```js
// The demo the voice guide walks the user through.
//
// Each step has:
//   id        - stable identifier
//   field     - DOM id of the form element this step is about (for visual highlight); null = none
//   narration - what the guide SAYS out loud for this step (spoken-style, short sentences)
//   action    - what the guide DOES on the form for this step (it fills it in itself):
//                 { type: "type",   field, value }  -> types value into an input
//                 { type: "select", field, value }  -> picks a value in a <select>
//                 { type: "click",  field }          -> clicks an element (e.g. submit)
//               omit/null for steps with no on-screen action.
//   context   - extra background the brain (Claude) can use to ANSWER questions about this
//               step. Never spoken; only feeds the Q&A so answers stay on-topic.
//
// Keep narration short: it is read aloud and long monologues hurt voice latency.

export const DEMO = {
  // Product being demoed — gives Claude global context for off-step questions.
  product:
    "Nova is a sign-up form for a productivity app. New users create an account by " +
    "entering their name and email, picking a plan (Free, Pro, or Team), and submitting.",

  steps: [
    {
      id: "welcome",
      field: null,
      narration:
        "Hi! Let me show you how to sign up. I'll fill it in as I go, " +
        "and you can stop me any time to ask a question. Here we go.",
      action: null,
      context:
        "This is the opening. The whole demo takes under a minute. The guide fills the form " +
        "itself. The user can interrupt by speaking, or say 'next' to skip ahead.",
    },
    {
      id: "name",
      field: "name",
      narration: "First, we type the full name here in the Name field.",
      action: { type: "type", field: "name", value: "Jane Doe" },
      context:
        "The Name field is a plain text input. It accepts any name. It is required.",
    },
    {
      id: "email",
      field: "email",
      narration: "Then the email address — that's where the confirmation link goes.",
      action: { type: "type", field: "email", value: "jane@example.com" },
      context:
        "The Email field needs a valid email like you@example.com. A confirmation link is " +
        "emailed after sign-up. The email is required and must be unique.",
    },
    {
      id: "plan",
      field: "plan",
      narration: "Now we pick a plan. I'll choose Pro — it's the popular one for individuals.",
      action: { type: "select", field: "plan", value: "pro" },
      context:
        "Plans: Free (no cost, core features), Pro (paid, advanced features for one person), " +
        "Team (paid, adds shared workspaces and admin controls for multiple people). " +
        "You can change your plan later at any time.",
    },
    {
      id: "submit",
      field: "submit",
      narration: "And finally, we click Create Account to finish.",
      action: { type: "click", field: "submit" },
      context:
        "The Create Account button submits the form. Nothing is charged yet on paid plans " +
        "until the trial ends. After this, the user lands on their new dashboard.",
    },
    {
      id: "done",
      field: null,
      narration:
        "And that's it — the account is created! Want me to go through anything again?",
      action: null,
      context:
        "The demo is finished. The user now has an account. They can ask follow-up questions " +
        "or restart the demo.",
    },
  ],
};
```

#### `server.js`

```js
import "dotenv/config";
import express from "express";
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

if (!ANTHROPIC_API_KEY) console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/answer will fail.");
if (!ELEVENLABS_API_KEY) console.warn("⚠  ELEVENLABS_API_KEY is not set — /api/tts will fail.");

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Expose the demo script to the frontend so narration text lives in one place.
app.get("/api/demo", (_req, res) => res.json(DEMO));

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
    "- If the question is unrelated or you don't know, say so briefly and offer to continue the demo.",
    "",
    `WHAT IS BEING DEMOED: ${DEMO.product}`,
    "",
    `THE USER IS CURRENTLY ON THIS STEP: "${step.narration}"`,
    `BACKGROUND FOR THIS STEP (use it to answer, do not read it out): ${step.context}`,
    "",
    "After you answer, the demo will resume from this same step, so you don't need to tell them what to do next.",
  ].join("\n");
}

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
      // latency. The "Output ONLY the words to be spoken" rule keeps Opus 4.8 from
      // leaking reasoning into the visible answer when thinking is off.
      system: buildSystemPrompt(step),
      messages: [...trimmed, { role: "user", content: question }],
    });

    const text = msg.content.find((b) => b.type === "text")?.text?.trim() ?? "";
    res.json({ text });
  } catch (err) {
    console.error("answer error:", err?.message || err);
    res.status(500).json({ error: "answer_failed", detail: err?.message });
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

app.listen(PORT, () => {
  console.log(`▶ Karumi voice demo running at http://localhost:${PORT}`);
  console.log(`  brain: ${CLAUDE_MODEL}  |  voice: ${ELEVEN_MODEL} (${ELEVEN_VOICE_ID})`);
});
```

#### `public/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nova — Voice Demo Guide</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div class="layout">
      <!-- The "product" being demoed: a mock sign-up form -->
      <main class="product">
        <h1>Create your Nova account</h1>
        <p class="sub">Sign up in under a minute.</p>

        <label for="name">Name</label>
        <input id="name" type="text" placeholder="Jane Doe" autocomplete="off" />

        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com" autocomplete="off" />

        <label for="plan">Plan</label>
        <select id="plan">
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="team">Team</option>
        </select>

        <button id="submit" type="button">Create Account</button>
      </main>

      <!-- The voice guide control + status panel -->
      <aside class="guide">
        <div class="guide-head">
          <span id="orb" class="orb idle"></span>
          <div>
            <div class="guide-title">Voice Guide</div>
            <div id="status" class="status">Idle</div>
          </div>
        </div>

        <div class="controls">
          <button id="startBtn" class="primary">Start demo</button>
          <button id="nextBtn" disabled>Next step</button>
          <button id="repeatBtn" disabled>Repeat</button>
          <button id="stopBtn" disabled>Stop</button>
        </div>

        <p class="hint">
          The guide fills in the form itself as it explains, step by step. Speak any time to
          ask a question — it pauses, answers, then resumes. Say "next" to skip ahead.
          Tip: use headphones so the guide doesn't hear its own voice.
        </p>

        <div class="transcript" id="transcript" aria-live="polite"></div>
      </aside>
    </div>

    <script src="/app.js"></script>
  </body>
</html>
```

#### `public/styles.css`

```css
:root {
  --bg: #0f1117;
  --panel: #1a1d27;
  --line: #2a2e3c;
  --text: #e7e9ef;
  --muted: #9aa0b0;
  --accent: #4f7cff;
  --accent-2: #34d399;
  --warn: #f59e0b;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: radial-gradient(1200px 600px at 70% -10%, #1b2030, var(--bg));
  color: var(--text);
  min-height: 100vh;
}

.layout {
  max-width: 1000px;
  margin: 0 auto;
  padding: 48px 24px;
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 28px;
  align-items: start;
}

@media (max-width: 820px) {
  .layout { grid-template-columns: 1fr; }
}

/* ---- Product (mock form) ---- */
.product {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 28px;
}
.product h1 { margin: 0 0 4px; font-size: 22px; }
.product .sub { margin: 0 0 22px; color: var(--muted); font-size: 14px; }

.product label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin: 16px 0 6px;
}
.product input,
.product select {
  width: 100%;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: #11141d;
  color: var(--text);
  font-size: 15px;
  transition: box-shadow .2s, border-color .2s;
}
.product button#submit {
  margin-top: 22px;
  width: 100%;
  padding: 12px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

/* Highlight the field the guide is currently talking about */
.highlight {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px rgba(79, 124, 255, .25);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(79, 124, 255, .18); }
  50%      { box-shadow: 0 0 0 6px rgba(79, 124, 255, .30); }
}

/* ---- Guide panel ---- */
.guide {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 22px;
}
.guide-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.guide-title { font-weight: 600; }
.status { font-size: 13px; color: var(--muted); }

.orb {
  width: 36px; height: 36px; border-radius: 50%;
  background: #444; flex: 0 0 auto;
  transition: background .2s, box-shadow .2s;
}
.orb.idle      { background: #3a3f4d; }
.orb.narrating { background: var(--accent);   box-shadow: 0 0 0 6px rgba(79,124,255,.18); animation: pulse 1.4s infinite; }
.orb.listening { background: var(--accent-2); box-shadow: 0 0 0 6px rgba(52,211,153,.18); animation: pulse 1.4s infinite; }
.orb.answering { background: var(--warn);     box-shadow: 0 0 0 6px rgba(245,158,11,.18); animation: pulse 1.0s infinite; }

.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.controls button {
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: #11141d;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
}
.controls button.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 600; }
.controls button:disabled { opacity: .45; cursor: not-allowed; }

.hint { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 4px 0 16px; }

.transcript {
  border-top: 1px solid var(--line);
  padding-top: 14px;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 14px;
}
.msg { padding: 9px 12px; border-radius: 10px; line-height: 1.45; }
.msg.guide  { background: #182338; align-self: flex-start; }
.msg.user   { background: #20262f; align-self: flex-end; }
.msg .who   { display: block; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
```

#### `public/app.js`

```js
// Interactive voice demo guide — frontend state machine.
//
// Modes:
//   idle       -> nothing running
//   narrating  -> playing a step's narration (mic open for barge-in)
//   listening  -> finished narrating, waiting for a question or "next"
//   answering  -> user interrupted; we stopped narration and are answering
//
// Barge-in is the core feature: while narrating, the moment the user starts
// speaking (>=2 interim words) we stop the audio, capture the question, answer
// via Claude, then resume from the same step.

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
  stepIndex: 0,
  history: [],        // [{role, content}] sent to Claude for context
  audio: null,        // current HTMLAudioElement
  busy: false,        // awaiting a Claude answer (don't accept new input)
  sessionActive: false,
};

let DEMO = null;
let recognition = null;

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
function speak(text) {
  return new Promise((resolve) => {
    stopAudio();
    const url = "/api/tts?text=" + encodeURIComponent(text);
    const audio = new Audio(url);
    state.audio = audio;
    const done = () => { if (state.audio === audio) state.audio = null; resolve(); };
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
    state.audio = null;
  }
}

// ---- Demo flow ----------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// True while the guide should keep auto-driving this step (no barge-in, still live).
const driving = () => state.mode === "narrating" && state.sessionActive;

async function narrate(i) {
  state.stepIndex = Math.max(0, Math.min(i, DEMO.steps.length - 1));
  const step = DEMO.steps[state.stepIndex];
  highlightField(step.field);
  addMsg("Guide", step.narration);
  setMode("narrating", `Step ${state.stepIndex + 1}/${DEMO.steps.length}`);

  await speak(step.narration);
  if (!driving()) return; // interrupted during narration

  // The guide performs the step itself (types the name, picks the plan, clicks submit...).
  if (step.action) {
    await performAction(step.action);
    if (!driving()) return; // interrupted mid-action
  }

  // Auto-advance to the next step; the last step waits for questions.
  if (state.stepIndex < DEMO.steps.length - 1) {
    await wait(900);
    if (driving()) narrate(state.stepIndex + 1);
  } else {
    highlightField(null);
    enterListening();
  }
}

// Perform a step's on-screen action on the mock form.
async function performAction(action) {
  const el = document.getElementById(action.field);
  if (!el) return;
  if (action.type === "type") {
    await typeInto(el, action.value);
  } else if (action.type === "select") {
    el.value = action.value;
    el.dispatchEvent(new Event("change"));
  } else if (action.type === "click") {
    markSubmitted();
  }
}

// Type character-by-character so the demo looks live; bail out if barge-in happens.
async function typeInto(el, text) {
  el.focus();
  el.value = "";
  for (const ch of text) {
    if (!driving()) return; // user interrupted — stop typing
    el.value += ch;
    await wait(45);
  }
}

function markSubmitted() {
  const btn = document.getElementById("submit");
  btn.textContent = "Account created";
  btn.style.background = "var(--accent-2)";
  btn.disabled = true;
}

function resetForm() {
  document.getElementById("name").value = "";
  document.getElementById("email").value = "";
  document.getElementById("plan").value = "free";
  const btn = document.getElementById("submit");
  btn.textContent = "Create Account";
  btn.style.background = "";
  btn.disabled = false;
}

function enterListening() {
  setMode("listening", "Listening — ask a question or say \"next\"");
}

function nextStep() {
  if (state.stepIndex < DEMO.steps.length - 1) narrate(state.stepIndex + 1);
  else { highlightField(null); setMode("listening", "Demo finished — ask anything or restart"); }
}

async function ask(question) {
  state.busy = true;
  stopAudio();
  setMode("answering", "Thinking…");
  addMsg("You", question);
  state.history.push({ role: "user", content: question });

  let answer = "Sorry, I couldn't get that. Let's keep going.";
  try {
    const r = await fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question,
        stepIndex: state.stepIndex,
        history: state.history.slice(-6),
      }),
    });
    const data = await r.json();
    if (data.text) answer = data.text;
  } catch (e) {
    console.error(e);
  }

  state.history.push({ role: "assistant", content: answer });
  addMsg("Guide", answer);
  setMode("answering", "Answering…");
  await speak(answer);
  state.busy = false;

  // Resume from the same step (the spec: "Resume demo from paused step").
  if (state.sessionActive) {
    setMode("narrating", "Resuming…");
    await speak("Okay — back to it.");
    if (state.sessionActive) narrate(state.stepIndex);
  }
}

// ---- Speech recognition (browser STT + barge-in) ------------------------------
const COMMANDS = {
  next: /^(next|continue|go on|go ahead|proceed|skip|move on)\b/,
  repeat: /\b(repeat|say that again|again|one more time)\b/,
  stop: /\b(stop|end demo|that's all|cancel)\b/,
};

function wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

function setupRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onresult = (event) => {
    if (!state.sessionActive) return;
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }

    // Barge-in: user starts talking over the narration -> pause immediately.
    if (state.mode === "narrating" && !state.busy && wordCount(interim) >= 2) {
      stopAudio();
      setMode("answering", "Listening to your question…");
    }

    if (!final) return;
    const text = final.trim();
    const lc = text.toLowerCase();
    if (state.busy) return; // ignore input while an answer is being fetched

    if (COMMANDS.stop.test(lc)) return stopDemo();
    if (COMMANDS.next.test(lc)) return nextStep();
    if (COMMANDS.repeat.test(lc)) return narrate(state.stepIndex);

    if (wordCount(text) >= 1) ask(text);
  };

  // The API stops on its own periodically; restart while the session is live.
  rec.onend = () => { if (state.sessionActive) { try { rec.start(); } catch {} } };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setMode("idle", "Mic blocked — allow microphone access and reload");
      state.sessionActive = false;
    }
  };
  return rec;
}

// ---- Session control ----------------------------------------------------------
async function startDemo() {
  state.history = [];
  state.stepIndex = 0;
  state.sessionActive = true;
  resetForm();

  recognition = setupRecognition();
  if (!recognition) {
    setMode("idle", "This browser has no Speech Recognition — use Chrome or Edge");
    state.sessionActive = false;
    return;
  }
  try { recognition.start(); } catch {}
  narrate(0);
}

function stopDemo() {
  state.sessionActive = false;
  stopAudio();
  if (recognition) { try { recognition.stop(); } catch {} }
  highlightField(null);
  setMode("idle", "Stopped");
}

// ---- Wire up ------------------------------------------------------------------
els.startBtn.addEventListener("click", startDemo);
els.nextBtn.addEventListener("click", () => state.sessionActive && nextStep());
els.repeatBtn.addEventListener("click", () => state.sessionActive && narrate(state.stepIndex));
els.stopBtn.addEventListener("click", stopDemo);

(async function init() {
  try {
    DEMO = await (await fetch("/api/demo")).json();
    setMode("idle", "Ready — press Start demo");
  } catch {
    setMode("idle", "Could not load demo script");
  }
})();
```

### 5.5 Configurar `.env`

```bash
cp .env.example .env
```

Edita `.env` y pon tus claves reales en `ANTHROPIC_API_KEY` y `ELEVENLABS_API_KEY`. Reglas para
no fallar (ver §6 para el detalle):
- Sin comillas, sin espacios al inicio/final.
- En WSL/Windows, asegúrate de que el archivo no tenga finales de línea `\r` (CRLF).
- La clave de ElevenLabs se ve entera **solo al crearla**; cópiala en ese momento.

### 5.6 Arrancar y probar

```bash
npm start
```

Abre **http://localhost:3000 en Chrome/Edge**, con **auriculares**, pulsa *Start demo* y permite
el micrófono. La guía narra, rellena el formulario y avanza sola. Habla para preguntar; di
"next" / "repeat" / "stop".

---

## 6. Catálogo de errores y su solución

Estos son **todos** los problemas que aparecieron, con síntoma → causa → solución. La mayoría no
eran de código, sino de entorno.

### Error 1 — "Pulso Start y no rellena el formulario / parece que no pasa nada"

- **Causa:** la primera versión solo **narraba** el paso de bienvenida y resaltaba el campo,
  esperando que el usuario escribiera y dijera "next". No auto-rellenaba ni auto-avanzaba.
- **Solución:** se añadió un `action` por paso en `demo-script.js` (`type` / `select` / `click`)
  y la lógica en `app.js` (`performAction`, `typeInto`, auto-avance en `narrate`). Ahora la guía
  escribe en los campos, elige el plan, pulsa enviar y pasa sola al siguiente paso.
- **Lección entre líneas:** "demo" significaba *demostrar haciendo*, no solo describir.

### Error 2 — "Rellena el formulario pero no suena nada de voz"

- **Síntoma:** el formulario se rellena (es frontend puro) pero no hay audio.
- **Causa:** **no existía el archivo `.env`**, así que el servidor arrancaba sin
  `ELEVENLABS_API_KEY` y la llamada a ElevenLabs devolvía error. Además, el fallo se tragaba en
  silencio en `speak()`.
- **Solución:**
  1. Crear `.env` (`cp .env.example .env`) y poner la clave.
  2. Reiniciar el servidor (lee el `.env` solo al arrancar).
  3. Se hizo el error **visible**: ahora `speak()` muestra "No voice: ..." en el panel y lo
     registra en consola; y `/api/tts` devuelve el motivo real de ElevenLabs.
- **Cómo detectarlo:** mira el log del servidor (`tts upstream error: ...`) y la consola del
  navegador.

### Error 3 — `tts upstream error: 401 {"detail":{"status":"invalid_api_key"}}`

- **Síntoma:** ElevenLabs responde 401 con `invalid_api_key` / "Invalid API key".
- **Causa:** la **clave en sí no es válida**. Importante: `invalid_api_key` **no** es un problema
  de permisos/restricciones (eso daría `missing_permissions`). Es que el valor de la clave no se
  reconoce: copiada con un carácter de menos, revocada, de otra cuenta, o copiada **enmascarada**
  desde el dashboard (ElevenLabs solo muestra la clave entera al crearla).
- **Solución:**
  1. En ElevenLabs → *API Keys* → crear una clave nueva con **acceso completo / sin
     restricciones** (para no toparte luego con `missing_permissions` al usar TTS).
  2. **Copiarla entera en el momento de crearla.**
  3. Pegarla en `.env` (sin comillas/espacios) y **reiniciar** el servidor.
- **Verificación definitiva** (prueba la clave directamente contra ElevenLabs, sin pasar por el
  servidor):
  ```bash
  cd karumi-voice-demo
  KEY=$(grep -E '^ELEVENLABS_API_KEY=' .env | head -1 | cut -d= -f2-)
  curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/user
  ```
  `200` = clave válida. `401` = clave inválida, vuelve a crearla/copiarla.

### Gotchas de entorno (causas frecuentes de "no funciona")

- **Hay que reiniciar el servidor tras editar `.env`.** `dotenv` lee las variables solo al
  arrancar; un servidor ya en marcha sigue con los valores viejos. Ctrl+C y `npm start`.
- **CRLF de Windows en WSL.** Si editas `.env` con un editor de Windows, las líneas pueden
  acabar en `\r`, que se cuela en el valor de la clave y la invalida. Diagnóstico:
  ```bash
  grep -E '^ELEVENLABS_API_KEY=' .env | cat -A | tail -1   # ¿aparece ^M$ al final?
  ```
  Arréglalo guardando el archivo con finales de línea LF, o `sed -i 's/\r$//' .env`.
- **Comillas o espacios en `.env`.** Pon `CLAVE=valor`, sin comillas ni espacios alrededor.
- **Solo Chrome/Edge.** La Web Speech API (el oído) no existe en Firefox/Safari. En otros
  navegadores el panel avisa y la voz/relleno siguen, pero no hay barge-in por voz.
- **Eco / falsos barge-in.** Sin auriculares, el micro oye la propia voz de la guía y puede
  auto-interrumpirla. Se mitiga exigiendo ≥2 palabras para disparar la interrupción, pero los
  auriculares son el arreglo real.
- **`voice not found`** (si cambiaste `ELEVENLABS_VOICE_ID`): usa un ID de voz que exista en tu
  cuenta. El de por defecto (`21m00Tcm4TlvDq8ikWAM`, "Rachel") existe en todas.
- **`/api/answer` da 500**: falta o es inválida `ANTHROPIC_API_KEY`. El log del servidor lo dice.

---

## 7. Chuleta de diagnóstico (comandos)

```bash
cd karumi-voice-demo

# ¿Qué claves hay en .env? (solo presencia/longitud, sin imprimir secretos)
for v in ANTHROPIC_API_KEY ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID ELEVENLABS_MODEL CLAUDE_MODEL; do
  line=$(grep -E "^$v=" .env 2>/dev/null | head -1); val=${line#*=}
  if [ -z "$line" ]; then echo "$v: (ausente)"; elif [ -z "$val" ]; then echo "$v: (vacío)"; else echo "$v: ${#val} chars"; fi
done

# Probar la clave de ElevenLabs directamente (200 = válida, 401 = inválida)
KEY=$(grep -E '^ELEVENLABS_API_KEY=' .env | head -1 | cut -d= -f2-)
curl -s -o /dev/null -w "ElevenLabs /v1/user -> HTTP %{http_code}\n" -H "xi-api-key: $KEY" https://api.elevenlabs.io/v1/user

# Probar el endpoint de voz del propio servidor (necesita el server arrancado)
curl -s "http://localhost:3000/api/tts?text=hello%20there" -o /tmp/voice-test.mp3 -w "HTTP %{http_code}, %{size_download} bytes\n"; head -c 120 /tmp/voice-test.mp3; echo
# 200 + miles de bytes = OK. 502 = el head muestra el motivo real de ElevenLabs.

# ¿Detecta CRLF en .env?
grep -E '^ELEVENLABS_API_KEY=' .env | cat -A | tail -1   # un ^M$ al final = problema
```

---

## 8. Adaptar a otra demo

- **Cambiar el contenido:** edita solo `demo-script.js`. Por cada paso defines `narration` (lo
  que dice), `action` (lo que hace: `type` en un input, `select` en un desplegable, `click` en un
  botón), `field` (id del elemento a resaltar) y `context` (lo que Claude usa para responder).
- **Cambiar el "producto":** ajusta el formulario en `public/index.html` (los `id` deben coincidir
  con los `field`/`action.field` del guion).
- **Cambiar voz/modelo/velocidad:** variables en `.env` (`ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`,
  `CLAUDE_MODEL`). Para más latencia baja: `CLAUDE_MODEL=claude-haiku-4-5` y
  `ELEVENLABS_MODEL=eleven_flash_v2_5`.
- **Cambiar el carácter del agente:** el system prompt está en `buildSystemPrompt()` en
  `server.js`. Ahí viven las reglas (inglés, breve, sin jerga, etc.).
- **Ritmo:** velocidad de tecleo (`await wait(45)` en `typeInto`) y pausa entre pasos
  (`await wait(900)` en `narrate`), ambas en `app.js`.

---

## 9. Checklist de arranque (TL;DR)

1. `npm install`
2. `cp .env.example .env` y rellena `ANTHROPIC_API_KEY` y `ELEVENLABS_API_KEY` (clave de
   ElevenLabs con acceso completo, copiada entera, sin comillas/espacios/`\r`).
3. `npm start`
4. Comprueba la voz: `curl ... /v1/user` debe dar `200` (ver §7).
5. Abre http://localhost:3000 en **Chrome/Edge**, con **auriculares**, *Start demo*, permite el
   micro.
6. Si algo falla: mira el log del servidor y la consola del navegador (ahora los errores se ven).

---

## 10. Mejoras y vía de producción

- **ElevenLabs Conversational AI (Agents) con Claude como custom LLM.** Si el barge-in manual da
  problemas o quieres turn-taking de producción, ElevenLabs puede gestionar todo el bucle de voz
  (micro, detección de turno, interrupción, TTS) y tú solo conectas Claude como LLM. Aquí se usan
  las APIs crudas para tener control total y porque el stack elegido era "Claude + ElevenLabs".
- **Streaming frase a frase Claude → TTS.** Para respuestas largas, ir mandando a ElevenLabs cada
  frase según Claude la genera, en vez de esperar la respuesta completa. Baja la latencia
  percibida.
- **STT de producción.** Sustituir la Web Speech API (solo Chrome/Edge) por una API de STT en
  streaming para soportar todos los navegadores.
- **Modo sin voz (subtítulos).** Fallback por si falla la red o la cuota de ElevenLabs en el
  hackathon: mostrar la narración y las respuestas como texto en pantalla.
```
