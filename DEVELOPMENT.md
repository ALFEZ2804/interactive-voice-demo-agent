# Development Guide

This document describes the current implementation. The README is the canonical guide for installing and running the project.

## Repository map

- demo-script.js defines the CRM walkthrough, its narration, browser actions, and the context supplied to the language model.
- public/app.js coordinates speech, audio playback, interruptions, navigation, and resuming the walkthrough.
- public/human.js implements the visible cursor and human-like browser actions.
- public/index.html and public/styles.css implement the fictional CRM interface.
- server.js serves the application and connects it to Anthropic, ElevenLabs, and optionally Deepgram.

## Interaction flow

The walkthrough is scripted, while the language model handles contextual questions, voice-directed navigation, and email drafting. When a user interrupts, the app stops the current audio, listens for the question, answers it, and resumes from the current action checkpoint. The user can also pause, continue, restart, or finish the demo.

The Communications screen generates an email draft for the selected fictional contact. The user can edit and preview the draft; the project does not send the email.

## Local development

1. Follow the setup instructions in README.md.
2. Run npm run dev to restart the server automatically when server-side files change.
3. Use Chrome or Edge and grant microphone access. If DEEPGRAM_KEY is not configured, speech recognition uses the browser API.
4. Use QA.md as the manual regression checklist.

There is no branch-specific version of the walkthrough: main is the source of truth.

## Security and data

Store provider keys only in a local .env file. Never place keys in browser code, logs, screenshots, or committed examples. The CRM data is fictional and kept in browser memory; there is no persistent customer data.
