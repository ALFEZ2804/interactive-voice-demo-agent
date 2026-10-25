# Contributor Guide

## Project

A browser-based voice agent that guides a user through a fictional sales CRM. The walkthrough is defined in demo-script.js; voice orchestration and browser actions are implemented in public/.

## Stack

- Node.js and Express server.
- Anthropic Claude for contextual answers and email drafts.
- ElevenLabs for streaming text-to-speech.
- Optional Deepgram streaming speech recognition, with a browser speech-recognition fallback.
- Vanilla JavaScript, HTML, and CSS for the browser application.

## Key files

- server.js: API routes, provider integrations, and optional speech-recognition proxy.
- demo-script.js: scripted tour steps, actions, narration, and answer context.
- public/app.js: conversation state, interruption handling, navigation, and checkpoints.
- public/human.js: cursor movement and browser input actions.
- public/index.html: fictional CRM interface.
- QA.md: manual regression checklist.

## Development commands

~~~sh
npm install
npm run dev
~~~

Set provider credentials in a local .env file based on .env.example. Never commit secrets or put them in browser code. The current CRM demo is on main; do not rely on branch-specific setup instructions.

## Product boundaries

The app is a guided demo, not a general-purpose autonomous agent. CRM state is in-memory demo data, and email generation produces a draft preview without sending it.
