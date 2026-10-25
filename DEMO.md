# Demo walkthrough

This walkthrough is designed for a short portfolio review. It uses fictional CRM records and does not send data to a real CRM.

## Before you start

1. Follow the setup in [README.md](README.md).
2. Start the app and open `http://localhost:3000` in Chrome or Edge.
3. Allow microphone access and select **Start demo**.
4. Use headphones to reduce speech-recognition feedback.

The guided voice loop needs Anthropic and ElevenLabs credentials. Deepgram is optional: without it, the browser speech-recognition API is used. Provider requests can incur usage charges.

## Suggested three-minute tour

1. Let the agent introduce the dashboard and narrate the pipeline summary.
2. Interrupt it while it is speaking and ask: **“What does this number represent?”** The agent should stop playback, answer in the context of the current screen, and continue the tour.
3. Ask: **“Show me the pipeline.”** The agent should navigate to the pipeline view.
4. Ask to add a contact and provide a fictional name and company. The browser action engine should fill the form and save the local demo record.
5. Open Communications and ask the agent to draft a follow-up email for a contact. Review and edit the generated draft; it is only a preview and is never sent.
6. Ask the agent to finish the demo.

## What to notice

- Speech playback can be interrupted (barge-in).
- Questions use the current walkthrough step as context.
- The agent can jump to another walkthrough step on request.
- Browser actions manipulate the visible CRM rather than describing actions only.
- The email remains editable and the project makes no external send request.

## Troubleshooting

- **No microphone prompt:** check the browser's site permissions and reload.
- **No speech input:** use Chrome or Edge; if Deepgram is not configured, the app relies on browser speech recognition.
- **No spoken answer or email draft:** check the server terminal and confirm the Anthropic and ElevenLabs keys are present in `.env`.
- **Unexpected demo state:** reload the page; demo records live in browser memory.

## Scope

The walkthrough is a product-demo prototype. Its CRM records are fictional and in-memory. It is not connected to an actual CRM, and generated emails are not sent.
