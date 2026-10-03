# Full-context heat assessment

## Scope and intended outcome

The owner wants assessment of the whole recorded relationship, including both backgrounds, where and how the pair met, prior complete topics, warming attempts and responses, subsequent handling, reply timing, and the current meeting arrangement. The adult user's longer-term goal can include mutually wanted intimacy. The current product milestone remains online interaction toward a mutually agreed offline meeting.

Sexual attraction, trust, and willingness to pursue a romantic relationship require separate evidence. They are interpretation questions, not three additional invented scores. Heat, flirting, a meeting, or past intimacy does not establish consent to a subsequent act. Sex does not guarantee a romantic relationship. Explicit boundaries remain relevant unless later records provide actual evidence of a change.

## Input path and authority

| Input | Current path and treatment |
| --- | --- |
| Both backgrounds and how the pair met | `buildChatContext` preserves user background, current style, growth goals, relationship goal, counterpart introduction, channel, offline scene, background, and reported prior rounds. |
| Questionnaire and expression preferences | Every answered original question and its real answer remains in context alongside explicitly provisional hypotheses. Questions may be skipped; missing answers are not neutral scores. Only the account's adopted abstract expression rules are added. |
| Complete saved conversation | Both SQLite and Postgres `listMessages` read every message for the account and counterpart in recorded order, with no last-N limit. `capturedChatSnapshot` passes the entire result to classification, reply, and manual field-coach plan generation. |
| Warming, handling, and boundaries | Reconstructed from original saved messages over the full history, not from a recent-text window or a user's outcome label. The shared model instructions and plan instructions explicitly require reviewing earlier evidence and later changes. |
| Timing | Message provenance, application recording time, optional user-reported WeChat time, and interval reliability survive serialization. Application intervals are estimates; user-reported times are not platform verification. A single unexplained delay is not the relationship state. |
| Meeting | The current reported arrangement is included. A confirmed public meeting is not consent to a private invitation or further intimacy. |
| Automatically organized background | Classification and reply share an evidence-linked `contextUpdates` output. Saved results project background facts and meeting status into the existing UI; original profiles and full messages remain authoritative model input. Unsent suggestions, screenshot descriptions and uncertain interpretations do not become personal facts. Manual meeting decisions carry a source boundary, so unrelated subsequent messages cannot revive an old invitation. |
| Knowledge | All three native model operations send the exact full knowledge text. No summary or retrieval fragment replaces it. |
| Account MCP | Classification and reply call the same account-scoped API path as the web. The caller supplies the counterpart ID rather than a shortened transcript. Manual plan assessment currently remains a web/API operation. |
| Owner / legacy stateless MCP | Preserves every message the caller supplies. It cannot recover conversation the caller did not provide. |

`recordedContext` states the number and endpoints of supplied messages and explicitly says complete WeChat history has not been verified. Missing background remains unknown. “Full context” means every record available to this operation, not access to messages that were never recorded, deleted messages, or an independently verified complete WeChat export. Recorded order is retained; edited timestamps remain available to the model without silently reordering or rewriting the evidence.

Draft replies are not actual sent records. A draft associated through a follow-up keeps `inferred_from_followup` provenance; it is not proof the counterpart saw or accepted that wording. Raw feedback, private case ratings, unadopted style proposals, and messages belonging to another counterpart remain outside this context. Cleaning and owner review are required for shared knowledge promotion. This separation is intentional, not a history truncation.

There is no application-side message truncation in these paths. Request size limits reject oversized requests rather than shortening the transcript. This audit does not establish the upstream model's context capacity, attention quality, or accuracy on a long real conversation.

## Heat and trend contract

The existing five dimensions remain active interaction, response engagement, personal interest, reciprocal flirting, and action follow-through. Recommendation weights and the heat index are uncalibrated; neither is a success probability.

`provisional-five-dimensions-2` requires at least two observed dimensions and two distinct message IDs before producing a numeric heat score or trend. Distinct IDs are a minimal evidence-coverage check, not proof of statistical independence. Previously, one message cited by several dimensions could display 0 or 100 and a falling/rising trend even while marked insufficient. That path now returns `score: null` and an unknown trend. The existing UI renders this as “待判断”. An explicit negative boundary still produces `pause` even with sparse evidence.

There is no lexical rule assigning a laugh, emoji, or short reply a positive or negative value. Model instructions require interpreting it using the whole conversation. Earlier interest and earlier refusals cannot be erased solely by the last message.

Trend compares the same observed dimensions against an available evidenced baseline and requires at least two comparable dimensions. An insufficient entry does not become that baseline when older history is supplied. The API currently provides the previous successful classification only; therefore the displayed trend is an adjacent-assessment comparison and may be unknown after a sparse assessment. It is not a fitted long-term trajectory. The model receives all saved conversation for qualitative temporal reasoning regardless of the number of stored classifications.

## Owner case: repeated delayed laughs or emoji

The owner's 2026-10-01 follow-up describes earlier initiative or flirting followed by three replies several hours apart consisting only of laughter or emoji. Limited personal interest, an uninteresting topic, and difficulty knowing how to respond remain alternative explanations. The supplied branches are: with previously stronger interest (the owner uses `>65`), change to an interest actually present in the counterpart's profile or earlier words; with low prior investment, leave space until a concrete opportunity such as a user-provided Moments post; with prior mutual flirting, consider possible busyness and resume with another topic later, possibly in the evening. The intended style is light and playful rather than scrutinizing every word.

These are conditional coaching heuristics, not measured outcomes or a new scoring algorithm. The number 65 is uncalibrated and is neither a success probability nor a mechanical cutoff; an unavailable earlier score must not be fabricated. Busyness or boredom remains a hypothesis unless supported by actual words. Moments content must be provided by the user; no fetching or scraping is introduced. Evening is an optional contextual choice, not a mandatory timer. Earlier flirting cannot override an explicit refusal. The full knowledge supplement and short native/field-coach instructions preserve all these qualifications without changing output schemas or adding a model call.

## Verification and limits

`tests/full-context.test.mjs` covers 320-message conversations with an early private-place refusal, later warming and response, a work-shift explanation, later interest but uncertain romantic intent, a confirmed public meeting, and a final laugh/emoji. The fixtures cover app and offline introductions, all 30 questionnaire answers, timing provenance, missing background, exact full knowledge transmission through the native classification/reply/plan requests, web dispatch, account MCP, and stateless MCP. Drafts, raw feedback, and another counterpart's history are excluded.

`tests/domain.test.mjs` covers evidence thresholds, null heat and unknown trend from one observation, preservation of an explicit pause, and comparison of like dimensions. These tests use synthetic conversations and mocked model responses. They establish transport and deterministic safeguards, not model interpretation quality, calibrated attraction, dating outcomes, or live provider acceptance. Further evaluation needs reviewed whole-conversation cases with contradictory early/later evidence and documented uncertainty; raw external feedback is not an evaluation set.

## Directory reference heat and time — 2026-10-01

The owner requested compact numbers and gradual inactivity decay in the conversation list. This adds a read-time directory reference; it does not modify persisted model observations, the five-dimensional score, observed trend, Top Three eligibility or invitation gates. The initial rule subtracts one point per complete 24 hours and floors at zero. This is an adjustable product heuristic for attention allocation, not measured decay in attraction.

The baseline is the observed score rounded to the nearest five. For a sparse assessment it is the midpoint of the existing preliminary range rounded to the nearest five; the UI tooltip identifies it as an initial reference. Unknown remains null and a negative boundary remains a pause. The timer starts from the latest valid counterpart timestamp actually cited by that baseline, preferring corrected WeChat time to recorded time. Historical preliminary ranges retain their original evidence IDs. No valid source timestamp means no automatic deduction. Future timestamps produce zero elapsed days, never a bonus.

The list may retain the latest assessment for an append-only compatible conversation while the new messages await analysis. Appended messages cannot renew that old assessment's timer. Original message edits, annotations, timing corrections, substantive profiles, manual meetings or knowledge changes withdraw incompatible assessments. Display-only remarks do not invalidate them. Reanalysis of the same evidence, repeated reads, copied suggestions, unilateral outgoing messages and profile-save timestamps cannot refresh the anchor. New assessment evidence can establish a new baseline and anchor.

`directory.heat` is an additive API projection, evaluated using the server clock. It is never fed back as a source observation or stored as a repeatedly decremented score. The directory polling path is read-only and cannot invoke models or consume allowances. Tests cover exact day boundaries, clock edge cases, sparse ranges, refusals, original timestamps, account isolation, append-only readback and evidence corrections with injected clocks and providers.

## Sparse context still produces a useful next step — 2026-10-02

The owner clarified that a small amount of information should support an initial judgment and an actionable way to learn more, instead of waiting for an observation-count or score threshold. The native prompts no longer map broadly “insufficient input” to an entirely unknown focus. One message can support `ready/limited`, an evidenced working focus, a provisional heat range, and a concrete next step. Unknown dimensions stay unknown independently. Numeric-score coverage and refusal rules remain unchanged; neither blocks ordinary coaching. With no counterpart message, the current model entry still asks for the first message while the UI offers introductory guidance.

The UI distinguishes general guidance before a usable result from a completed provisional assessment. Both offer something concrete to do; neither fabricates a numerical score. A saved reply's actual guidance and explicit refusal take precedence over generic information-gathering copy. The complete knowledge includes the owner's G8 amendment, superseding older wording that could imply no judgment before sufficient observations.

The inspected local failure was `unrecognized_keys` within the five heat dimensions, not a minimum-message gate. Native classification now discards only surplus properties within those known dimension objects before strict validation. `level` and `evidenceIds` remain unmodified and fully validated, and extra dimensions or fields elsewhere still fail. This compatibility step uses the same provider response without a retry or extra model attempt. Protocol `native-coaching-7` separates new advice from earlier cached policy results. Mock checks cover a one-message judgment, ignored commentary, and invalid or duplicate evidence that must still fail; they do not establish real-provider effectiveness.

### Auxiliary extraction fault boundary — 2026-10-02

A later local classification failed because an automatically organized background fact quoted text that did not match its source. Protocol `native-coaching-8` validates and filters the auxiliary `contextUpdates` before parsing the complete coaching result: facts are independent, duplicate subject/field groups are discarded, and meeting evidence is checked separately. Invalid auxiliary structure yields an empty projection; a missing required native `contextUpdates` field still fails. Core heat/focus/coaching schemas and evidence checks are unchanged. Stored projections contain only accepted items and remain subject to strict source validation on readback. Refresh and cache invalidation do not trigger analysis; new recorded messages and explicit actions retain their existing budgeted path.
