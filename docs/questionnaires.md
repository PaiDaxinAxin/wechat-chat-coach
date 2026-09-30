# Original chat preference questionnaires

Status: implemented domain rules for the internal beta. Version: `custom-chat-preferences-1`; 2026-09-30.

These are original Chinese questions for this product. They describe self-reported habits and expression preferences, not official MBTI, Big Five, Enneagram or Gallup results. No psychometric validation, personality diagnosis or relationship-success prediction is claimed.

## Intake and access

The profile contains real background, current style, growth goals, relationship goal and a complete selected questionnaire. The short form has 10 items; the full form has 30 and is accepted only for a server-authorized `paid` account. An owner may grant a paid-beta plan; the questionnaire is not a payment system. Client-supplied roles or plans cannot authorize full answers.

Answers use the same five choices for every item: 1 strongly disagree, 2 disagree, 3 neutral/unsure, 4 agree, 5 strongly agree. Every item of the selected form is required, with no additional IDs and no fractional/out-of-range values. `validateProfile(input, serverPlan)` performs the domain permission check; the authenticated API owns the account plan and calls it before persistence.

`QUESTIONNAIRES` in `src/domain.mjs` is the one authoritative item inventory. The short form uses the first two items from each dimension; the full form uses all six. IDs are stable within this version. Questions may be shown in metadata; access control concerns submitting and using the full answers.

| Dimension | Short IDs | Full IDs | Intended interpretation |
| --- | --- | --- | --- |
| `directness` | `s01`–`s02` | `f01`–`f06` | Current comfort expressing a clear question, interest or proposal. |
| `warmth` | `s03`–`s04` | `f07`–`f12` | Self-reported attention to feelings and specific appreciation. |
| `playfulness` | `s05`–`s06` | `f13`–`f18` | Comfort with light humor and adjusting when it is not received. |
| `curiosity` | `s07`–`s08` | `f19`–`f24` | Following the other person's content while also sharing oneself. |
| `pacing` | `s09`–`s10` | `f25`–`f30` | Preference for observing reciprocity and respecting the pace. |

Reverse items are marked explicitly in metadata and scored as `6 − answer`. The dimension mean stays on a 1–5 scale; it is tagged `self_report` and `hypothesis`. A high or low value is not a universal ability judgment. Current habits and desired growth are separate: an effective new expression may be worth practicing even when it differs from present habits.

## Complete context

`buildChatContext` includes all four background/style/goal fields, every selected question's original text and answer, and the provisional custom dimension summaries in the model's `userProfile`. It does not substitute summaries for answers. Counterpart context includes meeting channel, app profile or offline scene, described background, previous rounds and the persisted meeting state when supplied. All supplied conversation messages remain in the chat context. The provider separately receives the complete knowledge text through `coach.mjs`.

The authenticated server must supply the persisted profile, counterpart, conversation and meeting belonging to the account. Domain functions do not authorize a caller. A confirmed meeting remains visible to the model, so the next suggestion can account for arrangements already agreed.

## Evidence and limits

Domain tests verify the 10/30 inventory, complete answers, server-plan check, reverse scoring, full-answer inclusion and meeting context. These tests establish the workflow contract, not questionnaire validity or effectiveness in real dating conversations. Actual user edits and observed interactions should inform later revisions. A future questionnaire version needs an explicit migration policy; existing IDs must not silently change meaning.

## Provisional heat rules

`computeHeat` consumes the classifier's five dimensions: active interaction, response engagement, personal interest, reciprocal flirting and action follow-through. `unknown` is excluded from the observed index and stays unknown in the result. Known levels have ordinal values `negative=-1`, `passive=0`, `positive=1`, `repeated_positive=2`. The index is `round(((mean of known values + 1) / 3) × 100)`. Each dimension has equal weight in this first rule version. This is an observed-interaction index, not a calibrated probability or a validated physical measure of attraction.

The response also retains message evidence IDs, unique evidence count through the IDs list, observed coverage and the classifier's qualitative confidence. A single shared message ID cannot establish enough independent observations merely by appearing in several dimensions.

| Status | Provisional admission rule |
| --- | --- |
| `pause` | Negative resistance overrides every numerical score. Stop the related advance. |
| `insufficient_evidence` | Less than two known dimensions or fewer than two unique message IDs. Collect context rather than label failure. |
| `high_invite` | At least three known dimensions and three message IDs; moderate/strong confidence; index at least 65; positive personal interest plus reciprocal flirting or action follow-through, and positive active interaction or response engagement; obstacle is not ambiguous. Consider a concrete, optional invitation. |
| `too_low` | At least three known dimensions and three message IDs; moderate/strong confidence; no positive dimensions, plus either two negative dimensions or at least four known dimensions and four message IDs. Pause investment pending meaningful new evidence. |
| `potential` | Remaining interactions with enough evidence to work on, including medium-low cases. No requirement to escalate every turn. |

Trends compare only dimensions known in both the current and most recent stored heat snapshot; at least two comparable dimensions are required. A difference of at least 10 index points produces `rising` or `falling`; otherwise `stable`. Changed unknown coverage alone does not imply a trend. Missing history yields `unknown`.

`rankTopThree` excludes paused, too-low and insufficient-evidence cases. Among eligible cases it ranks `index × coverage × confidenceFactor`, with factors limited=0.5, moderate=0.85, strong=1, then coverage/evidence count/stable ID tie breakers. It returns up to three IDs, which can be fewer than three. Reply latency alone is not an input. The thresholds and factors are transparent starting hypotheses to revise against reviewed feedback, not measured success odds.
