# Manual QA Checklist

Run this checklist against the current main branch. The product demo is in English and requires a microphone. Use Chrome or Edge; test with and without a DEEPGRAM_KEY if both speech-recognition paths need coverage.

## 1. Start and walkthrough

- Start the server with npm start and open http://localhost:3000.
- Allow microphone access and select Start demo.
- Confirm that the guide narrates the CRM tour and visibly performs the actions described in each step.
- Confirm the tour reaches Dashboard, Contacts, Pipeline, and Communications.

## 2. Barge-in and contextual answers

- Interrupt the guide while it is speaking. Confirm that audio stops promptly and the agent listens.
- Ask a question about the current screen. Confirm that the answer is brief and relevant to the demo.
- Confirm that the walkthrough resumes from its checkpoint without repeating completed actions.
- Interrupt with a navigation request, such as asking to see the pipeline, and confirm that the requested view opens.

## 3. Waiting and pause behavior

- Interrupt and ask a question; confirm the agent waits for the question and handles silence gracefully.
- Say “one moment” and remain silent. Confirm the demo stays paused until you speak again.
- Ask a follow-up question after an answer and confirm it is handled before the walkthrough continues.

## 4. CRM actions and email draft

- Confirm that the guide can add and edit a contact and advance a deal.
- In Communications, generate an email draft and verify that the subject, body, and preview appear.
- Edit the draft and confirm the preview updates.
- Confirm that no email is actually sent and that the data is demo-only.

## 5. Controls and recovery

- Test the voice commands “next”, “repeat”, and “stop”.
- Test the visible pause/continue, restart, and finish controls.
- Block microphone access and confirm the app reports a useful error instead of remaining silently inactive.
- Test a missing or invalid provider key and confirm the user receives a clear failure indication.

## 6. Speech-recognition paths

- With DEEPGRAM_KEY configured, confirm the app selects Deepgram and recognizes speech.
- Without DEEPGRAM_KEY, confirm Chrome or Edge browser recognition is used.
- With speakers instead of headphones, check for accidental self-interruption from audio echo.

Record the browser, speech-recognition path, and observed result for any failure. This is a manual checklist; it is not an automated test suite.
