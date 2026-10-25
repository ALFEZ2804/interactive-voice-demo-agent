# Interactive Voice Demo Agent

A browser-based voice agent that guides users through a fictional sales CRM. It narrates the tour, drives the interface, answers spoken questions in context, and resumes the walkthrough after an interruption.

## What it demonstrates

- **Voice interaction:** spoken narration with streaming text-to-speech, turn-taking, and barge-in.
- **Context-aware Q&A:** the agent answers questions about the current CRM screen and can navigate to a requested part of the demo.
- **UI control:** a browser-side action engine moves the cursor, types into fields, opens selectors, and clicks through the CRM.
- **AI-assisted email drafting:** the Communications screen generates an editable follow-up email and previews it before use.
- **Speech recognition options:** optional Deepgram streaming transcription, with the browser speech-recognition API as a fallback.

The CRM, contacts, and deals are fictional demo data held in the browser. The project does not connect to a real CRM or send emails.

## Architecture

The browser handles the microphone, speech recognition, audio playback, CRM UI, and guided actions. A Node.js and Express server keeps provider credentials on the server and exposes the demo, answer, text-to-speech, and email-draft endpoints. When Deepgram is configured, microphone audio is proxied through the server; otherwise, Chrome or Edge browser speech recognition is used.

The main walkthrough is defined in demo-script.js. The voice and interface orchestration lives in public/app.js, while public/human.js contains the cursor and input action engine.

## Run locally

Requirements: Node.js 18 or newer, a microphone, and Chrome or Edge. Create a local environment file from the template:

~~~powershell
Copy-Item .env.example .env
~~~

On macOS or Linux, use:

~~~sh
cp .env.example .env
~~~

Add the required ANTHROPIC_API_KEY and ELEVENLABS_API_KEY values to .env. DEEPGRAM_KEY is optional; without it, the app uses the browser speech-recognition fallback. Then install dependencies and start the server:

~~~sh
npm install
npm start
~~~

Open http://localhost:3000, allow microphone access, and select Start demo. Use headphones for the most reliable speech recognition, especially when using the browser fallback.

## Configuration and security

See .env.example for the available model, voice, and server settings. Keep provider credentials in .env; do not commit that file. The application sends requests to the configured AI, speech, and text-to-speech providers, so their API usage may incur charges.

## Scope and limitations

- This is a guided product-demo prototype, not an autonomous general-purpose agent.
- CRM state is local demo state and resets with the walkthrough; it is not persisted to a backend.
- The generated email is a draft preview; the app does not send it.
- The browser speech-recognition fallback is intended for Chrome or Edge.

See [QA.md](QA.md) for the manual interaction checklist and [GUIA.md](GUIA.md) for development notes.
