# Core acceptance

Updated September 25, 2026. **All criteria remain pending.** Isolated provider tests do not establish application acceptance. The [provider evaluation](provider-evaluation.md) records their results and limitations.

## Requirements and project choices

The [official challenge](https://nerdearla26.devpost.com/) requires five minimum capabilities:

1. At least one audio source.
2. Real-time original transcription in Spanish or English.
3. Real-time English-to-Spanish translation.
4. Visible captions.
5. Two simultaneous sessions and scaling instructions.

The project commits to microphone or mixing-console input and files sent at playback speed, with ES and EN samples. One installation serves one event with independent rooms and successive application sessions. Source language is fixed per session, and a session's streams are fixed when it is prepared: Spanish sessions offer Spanish original and English translation; English sessions offer English original and Spanish translation. Spanish-to-English translation extends the official minimum and is part of the core criteria below. Sessions prepared before this extension keep the streams they were prepared with.

React/TypeScript, one Node service, PostgreSQL, Clerk, Soniox, and MIT are project choices. One configured administrator controls the installation; attendees read without accounts. The core stores configuration and final text, with no permanent audio storage or public history.

The 30-minute concurrent test, corpus quality conditions, and translation p95 ≤5 s in each direction are internal acceptance conditions, not thresholds published by the organizers. Every criterion below must pass before optional features start. Passing an optional feature cannot compensate for a missing official minimum. Submission requirements remain subject to the [official rules](https://nerdearla26.devpost.com/rules).

## Acceptance criteria

Each result must identify the tested revision and supporting evidence. Record failures and unverified conditions; do not mark a criterion passed solely because its design or provider capability is documented.

| ID | Verifiable result | Status |
| --- | --- | --- |
| C01 | Clean installation with own accounts, authorized administrator, and HTTPS from another device. Visitors and other accounts cannot control rooms or send audio unless the installation runs with the explicit `DEMO_MODE=true` switch. | Pending |
| C02 | Two ES/EN samples use the real path; microphone or mixing-console input also works. Denied permission and missing sources have distinct diagnostics. | Pending |
| C03 | Two rooms with different content run for 30 minutes, including renewal during speech. No cross-room content, duplicates, or planned-handover loss. | Pending |
| C04 | ES/EN transcription and EN→ES and ES→EN translation appear in the selected language. Partials are replaceable; finals are persisted and ordered; translations are shared among readers. A session offers only the languages it has streams for. | Pending |
| C05 | Annotated corpus has no altered names, quantities, or negations and no omitted or invented meaning in either direction. Translation p95 ≤5 s from predefined acoustic ends to browser display, computed separately for EN→ES and ES→EN. Omission fails regardless of percentile. | Pending |
| C06 | Record first text, maximum update gap, and queue growth. No sustained queue growth; a slow reader does not stop another reader or room. | Pending |
| C07 | Internal navigation preserves capture; reject a second sender. Cutting one input does not stop another room. Reconnection preserves identity and marks unexpected loss. | Pending |
| C08 | Manual finish, file end, or failure during draining closes within the configured limit and identifies failed pending output. Preparing another talk preserves old text; starting changes identity and cursor. | Pending |
| C09 | Reader reload does not duplicate text. Old cursors/IDs expose no history. Restart preserves finals and marks active sessions interrupted. | Pending |
| C10 | No secrets in clients or logs. Expired authentication closes or revalidates channels. Replacing the administrator and restarting invalidates previous connections. Turning demo mode off invalidates anonymous console tabs on their next request. | Pending |
| C11 | Keyboard, focus, contrast, mobile, zoom, and accessible announcements meet the reading contract below. Record tested browsers and devices. | Pending |
| C12 | Reproducible installation, documented consumption and cost per room-hour, tested capacity distinct from estimates, and required licenses present. | Pending |
| C13 | Two administrators operate simultaneously from independent browsers, in demo mode and with Clerk: one session starts per room; a second source, a second test, and a start over another console's test are refused or require a bound confirmation; deleting and finishing another console's session never touches the other console's source; prepared sessions, drafts, and the visible session survive the other console's actions. | Pending |

## Contracts needed to run the checks

- **Authorization:** Clerk establishes identity. The server authorizes only the user matching `ADMIN_USER_ID`; missing configuration grants no administrative access. Check HTTP controls, audio, and persistent-connection opening and renewal. Validate allowed origins and room/session association. Expired identity requires revalidation or closure.
- **Text:** original and translated outputs have separate ordering by room, application session, output type, and configured language. A partial is revisable text; a final is text marked final by the provider. Replace partial hypotheses, persist finals before publishing, and do not promote partials at shutdown. Original and translated tokens need not match one to one.
- **Continuity:** provider connection renewal retains application session identity and must preserve continuous speech without loss or duplication. Unexpected interruption retains finals, allows authorized reconnection, and marks loss or its unknown extent. Closing or reloading a sending tab can interrupt capture.
- **Closure:** the initial drain limit is 15 seconds, configurable and recorded with the test. Stop input once, allow pending output until the limit, then mark incomplete output and finish. Late output from a closed execution must not silently change final text.
- **Public reading:** the initial window is 20 segments per selected stream, configurable, with no backward browsing. A stale or invalid cursor returns current state and resets. Preparing another session preserves the previous visible text; starting it changes identity and cursor. A slow reader may be disconnected to retrieve a fresh snapshot without blocking others.
- **Accessibility:** support keyboard, visible focus, sufficient contrast, 320 CSS-pixel layouts, and 200% zoom without clipping. Caption updates do not steal focus. Screen readers receive understandable finals and state changes rather than every partial token; announcements can pause without stopping capture. The public interface follows the reader language (Spanish or English), reflected in `<html lang>` and in state announcements; finals are announced with the language of their stream.

## Corpus and measurement

Use redistributable ES and EN speech samples with documented sources and permissions. Audit reference text by listening. Annotate units and acoustic ends before execution, including names, technical terms, quantities, negations, pauses, and continuous speech. Never supply expected transcripts to the recognizer. Keep difficult, missing, and uncertain units visible in results instead of removing them to improve metrics.

Send audio at playback speed. For C03, run different content in both rooms for 30 minutes, one Spanish-source and one English-source session, and renew provider connections during speech, not only during silence. If samples repeat, record repetition boundaries. Test the public reader from a fresh browser context without signing in.

For each reference unit in the source language, measure from its predefined acoustic end to browser display of the associated translation, separately for English-to-Spanish and Spanish-to-English. Record first appearance separately from completion of the unit's translated content and identify whether each is partial or final. Associate meaning for evaluation without inventing production token alignments or translation timestamps. A recording with input audio and screen on a shared timeline is suitable; when clocks differ, document synchronization and its uncertainty.

Report expected units, displayed units, omissions, p50, p95, and maximum for each translation direction; do not pool directions. Sort the measured delays and use nearest rank `ceil(0.95 × displayed units)` for p95. With no displayed units, report the percentile as unavailable. Omissions remain failures in the expected total and receive no fabricated latency. For fewer than 20 measured units, this p95 equals the maximum; repeated short excerpts do not establish production performance. No additional minimum sample count is imposed.

Record original and translated output separately, including language and partial/final state. Distinguish audio position, provider timing when available, Node receipt, ordered publication, and browser display. Neither Node receipt nor provider finalization replaces the acoustic starting point or the browser endpoint. There is no numeric original-transcription latency threshold; report first appearance, final-text delay, and unresolved issues.

Also record the longest update gap during speech and queue size and age throughout the run. Favorable early percentiles do not excuse sustained backlog growth. Preserve failed attempts, operational deadline expirations, client timeouts, and provider errors; record successful retries separately.

## Acceptance evidence

For each run, record revision, date, model/configuration, including source and target languages, sample identity, reference version, devices/browsers, duration, room/reader counts, renewal behavior, quality findings, timing points, queues, errors, and limitations. Set and record byte and time limits for reader queues in the first load test.

Document dated tariffs, currency, quotas, measured usage, and cost per room-hour for each source language. Two rooms for 30 minutes total one room-hour. Separate inference cost from hosting and storage. Scaling instructions must distinguish tested capacity from estimates and account for provider quotas, compute, connection routing, and delivery to readers.

Record C01–C12 outcomes here or in a linked report when application checks have been performed. Until then, their status remains pending.
