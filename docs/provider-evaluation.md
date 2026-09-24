# Speech provider evaluation

Evaluated on September 24, 2026. Decision: **use Soniox for the first application integration**. [Core acceptance](core-acceptance.md) remains pending.

All four English Soniox runs returned translated text; the last Gemini round published 13 of 20 translation requests before the instrument's deadline. These observations support trying Soniox in the application, but do not establish sufficient accuracy or browser latency. The project's earlier Soniox test report recommended resolving fidelity issues before integration; proceeding with a first integration is a project decision, not a changed test result.

## Test scope

Both providers received the same two 30-second conference excerpts, one English and one Spanish, as PCM16LE mono audio at 16 kHz. Audio was sent progressively in 100 ms blocks at playback speed. Expected transcripts were not injected into recognition.

The provisional reference transcript divides the excerpts into eight English and ten Spanish units, phrase-level segments with estimated acoustic ends. It was assembled from two full-file Gemini Transcribe outputs. Acoustic ends were annotated using 20 ms RMS windows and pauses below −45 dBFS, an energy criterion also used by Gemini's hybrid finalizer. That shared criterion can favor the hybrid configuration. Human listening and acoustic-boundary verification are still pending. Some excerpts begin or end mid-phrase. Word association, semantic correctness, and complete delivery are distinct checks.

Gemini used `gemini-3.5-transcribe-live` with `gemini-3.5-flash-lite` for separate text translation. Soniox used `stt-rt-v5` through WebSocket with native one-way English-to-Spanish translation, language hints, language identification, and endpoint detection. Spanish runs for both providers requested original transcription only.

The runs used different segmentation settings and occurred at different times. This is a comparison of observed processing paths, not a controlled estimate of each provider's intrinsic speed or accuracy.

## Observed results

| Check | Gemini | Soniox |
| --- | --- | --- |
| Last comparison round | Five audio runs: four English, using non-streaming, streaming, streaming, then non-streaming text translation, with 20 translation requests; one Spanish recognition-only run. Earlier diagnostics remain part of the evidence. | Eight audio runs: three per language sequentially, then one per language concurrently. |
| Delivery | 13 of 20 translations published; seven exceeded the instrument's four-second deadline after transcription confirmation. | All eight connections completed normally; all four English runs returned translations. Completion of a connection does not establish complete or faithful content. |
| English translation delay | Up to 10.228 s from a provisional acoustic end to ordered publication in Node, among 17 of 32 reference-unit observations across four runs. The other 15 observations have no measured translation delay, including units affected by expired requests and the unrecognized closing filler. The longest span of a single 30 s run with no new successful translation, including its start and end, was 18.155 s. | Up to 3.781 s from a provisional acoustic end to Node receipt of associated final translation text. Seven of eight units per English run had associated text; the eighth, a closing filler word, had none and remains counted as missing. Fillers were also dropped within several associated units. |
| Spanish original delay | Up to 6.398 s from a provisional acoustic end to Node receipt of associated final original text in the last round's single Spanish run. | Up to 6.800 s for the same measurement. Nine of ten units per run had associated text; the last unit is cut off and uncertain. |
| Fidelity | Hybrid finalization reduced observed delays, while segmentation variants also introduced or retained errors in terms, verb tense, and meaning. These comparisons use the unaudited reference described above. | A technical term was mistranscribed in all four Spanish runs. A possible subject change in all four English runs needs an audited reference; one translation changed verb tense. Associated text does not establish complete word coverage or fidelity. |
| Concurrency | The last round allowed up to two concurrent translation requests, but no two requests overlapped in its audio runs. That load was not validated. | Two independent connections overlapped for 29.998 s. No cross-stream text or API failures were observed in that instrument. |

The seven Gemini expirations in the last round were **local operational deadlines**, not seven provider HTTP failures. Earlier rounds separately recorded provider 503/504 responses and the instrument's 20 s client timeouts. Those attempts remain in the evidence; successful retries do not replace them.

Soniox's observed charge for the eight requests was **US$0.013028**, attributed through provider usage records. The inputs totaled 240 s; reported provider audio duration totaled 241.723 s. This does not establish production cost per room-hour or sustained capacity.

## What the timing numbers mean

- A **partial** is original or translated text the provider may revise. Soniox's first original partial arrived roughly 0.97–0.99 s after audio sending began in the sequential runs.
- A **final** is original or translated text the provider marks as final. This state does not guarantee accuracy or a completed sentence.
- The first final translated token arrived around 2.41 s after audio sending began in those English runs. This is not the completion time of the first reference unit. In one run, that unit's associated translation completed at 5.615 s from the same origin, or 2.155 s after its provisional acoustic end.
- Original and translated text are separate streams. No provisional translation tokens were observed in these Soniox runs; that observation does not justify treating every future translation token as final.
- Report output type, language, and partial/final state separately. All times here end at **Node receipt** or, where stated for Gemini, the instrument's ordered publication step. No browser display was measured.

Soniox had seven measurable English units and nine Spanish units per run; Gemini's last English runs had seven, one, five, and four measurable translated units. At these counts, nearest-rank p95 equals the maximum. Repeated runs of the same short excerpts are not an independent production sample. Missing or uncertain units remain in coverage totals, without fabricated latency values. Omissions fail acceptance even when the percentile over delivered units passes.

## Integration contract

Use one concrete Soniox integration. Each room's application session owns separate original and translated streams. A stream's language is the configured source language for original output or the configured target language for translated output; provider-detected token language is metadata, not a new stream identity. Keep finals ordered within each stream, replace its current partial hypothesis, and share results among attendees. Do not deduplicate by text alone: repeated words can be legitimate.

Soniox translation tokens have no one-to-one correspondence with original tokens or original-word timestamps. Preserve only timing information actually supplied and meaningful for that output. Browser latency must be measured against independently annotated speech. See the [real-time translation documentation](https://soniox.com/docs/translation/stt-translation/rt-translation) and [WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api).

A provider connection change must not create a new application session. Drain pending output when closing, bound the wait, and label missing content. The isolated scripts do not establish that provider connection renewal or recovery works in the application.

## Still required

- Audit the reference by listening, resolve uncertain boundaries, and prepare redistributable samples covering names, numerical quantities, and negations.
- Address observed fidelity errors and test technical context without inserting words absent from the audio. Soniox's [context support](https://soniox.com/docs/stt/concepts/context) is a candidate for that check, not a proven correction.
- Investigate delayed Spanish original finals and measure both first appearance and final text. No numeric original-transcription latency threshold has been set.
- Test microphone capture and the complete audio-to-browser path through the deployed service.
- Demonstrate two application rooms for 30 minutes, provider connection renewal during speech, session isolation, ordered persistence, reconnection, and bounded shutdown.
- Measure translation p95 ≤5 s from predefined acoustic ends to display, record omissions as failures, and report update gaps and queue growth separately.
- Document current tariffs, quotas, measured consumption, and cost per room-hour under the accepted configuration.

Neither provider has passed [C01–C12](core-acceptance.md#acceptance-criteria). Selecting Soniox does not add multi-provider support, automatic language changes, local inference, or voice synthesis to the core.

## Evidence handling

The local archive preserves scripts, dependency lockfiles, configurations, failed attempts, raw results, sample sources and hashes, and SHA-256 manifests. It is not part of the public repository. This summary is self-contained; it does not require access to private installation notes or raw transcripts. Redistribution rights for the conference excerpts have not been established, so they are not published as project samples.
