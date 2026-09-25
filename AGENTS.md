# Nerditulos

Nerditulos is a web application for live captioning and translation at events with simultaneous talks. One configured administrator prepares and supervises sessions in each room. Attendees choose a room and an available language, then follow captions in their browser without registering.

## Product priorities

- Deliver captions while the talk is happening.
- Keep audio, captions, and state isolated between rooms and sessions.
- Keep attendee access available without registration. Authenticate and authorize administrative access separately.
- Keep caption updates from stealing focus or unnecessarily moving the attendee's view within the current text window. This does not add history or backward browsing.

## Vocabulary

- Room: an event space whose talk attendees can follow.
- Session: the application's unit for preparing and supervising activity in a room. Keep application sessions distinct from sessions managed by the recognition provider.
- Partial: provisional original or translated text that the provider may update.
- Final: original or translated text that the provider marks as final.

Distinguish transcription in the original language from translation into another language. A final transcription result does not imply that its translation is ready.

## Audio and captions

Soniox is selected for the first integration. Keep original and translated text in separate streams identified by room, application session, output type, and language. Use the configured source language for the original stream and target language for the translated stream; provider-detected token language is metadata. Order and persist finals within each stream before publishing them. Do not require one-to-one correspondence between original and translated tokens or infer translation timestamps from original tokens.

Treat partials as revisable text. Update the current hypothesis rather than appending every partial as a new final fragment.

Preserve each result's association with its room and application session throughout processing and delivery. Check pending results when changing session shutdown, reconnection, or transitions between sessions.

Keep provider connection changes distinct from application session transitions. A provider reconnection does not by itself mean that the room's session has ended.

## Configuration and deployment

Keep the Soniox API key and Clerk secret key on the backend. The Clerk publishable key may be used by the frontend.

Clerk establishes identity; the server authorizes only the user matching ADMIN_USER_ID. Missing configuration and other signed-in accounts grant no administrative access. Check controls, audio, and persistent-connection opening and renewal; expired identity requires revalidation or closure.

DEMO_MODE=true is the only way to administer without identity: it is an explicit server switch for supervised showcases, never a default, and it keeps the origin check on mutations and on the audio socket. Several consoles may operate the same rooms at once in either mode: decide start, delete, and finish on the session's current state, serialized per room, and never let one console's action silently replace another console's source or interrupt its test without a confirmation bound to that test's id.

Update .env.example when required configuration changes. Use placeholders for secrets and keep real credentials out of code, logs, screenshots, and reports.

Preserve PostgreSQL data during routine container maintenance. Do not delete its persistent volume or use docker compose down -v as routine cleanup.

For work on the existing server, consult the local deployment notes at docs/infraestructura.local.md when available. These notes are not currently tracked in Git. If they are missing, obtain the target installation's configuration before changing its services or routing.

On that server, preserve the tunnel's routes for other applications and identify the process using the destination port before replacing a service.

Keep shared agent instructions in AGENTS.md. CLAUDE.md points to this file.

## Verification

Choose the smallest check that demonstrates the changed behavior. Use the repository's configured commands where available.

Use deterministic inputs to test message ordering, duplicate handling, room and session isolation, and caption presentation. Use real audio when validating recognition quality or end-to-end latency.

For latency checks, send audio at playback speed and measure caption display against the corresponding speech. Record the sample and start/end measurement points. Identify output type (original or translated), language, and partial/final state separately. Distinguish provider timing, Node receipt or publication, and browser display.

Use the task's acceptance criteria and [core acceptance](docs/core-acceptance.md) when changing core behavior. If no latency threshold is defined, report measurements without declaring latency acceptable.

When a change affects room isolation, test simultaneous rooms. When it affects public access, verify the attendee flow in a fresh browser context without signing in.

Preserve failed attempts and observed delays in test reports. Record successful retries separately.

Report what was verified, the result, and what remains unverified. Distinguish isolated tests from a complete audio-to-browser check.

The [provider evaluation](docs/provider-evaluation.md) records the current decision and its limits. It does not certify core acceptance. Keep repository documentation, configuration comments, and contribution templates in English.
