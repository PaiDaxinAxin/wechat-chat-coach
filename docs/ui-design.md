# Single conversation design

The owner requested one simulated WeChat conversation on 2026-09-30: the counterpart's messages and the user's pending reply are the main content; AI advice appears inside that conversation. The owner initially declined a separate AI chat; on 2026-10-01 the owner explicitly added a companion part named 场外教练 for whole-topic monitoring and evaluating the user’s initiative plans. The owner also requested day and night colors and deferred email, login and website authorization work for the local demo.

## Reference and scope

Read-only source: [LYNCA Design Standard 1.3.0](https://linear.app/lynca/document/infralynca-design-standard-505c197ca09a), effective 2026-09-29, canonical `updatedAt` `2026-09-29T14:13:47.813Z`. Its less-is-more hierarchy, truthful states, typography roles, keyboard access, minimum touch targets and restrained composition apply here. The implementation reference is the owner-export-checked Nocturne snapshot of 2026-09-07 and LYNCA overlays.

The personal project's visual values have one implementation home, `web/styles.css`. Night base roles, spacing, radii and font stacks follow the reference. The day palette and accent-tinted speaker bubbles are scoped product decisions for this chat demo, rather than changes to the company's design system. The same hierarchy and controls apply to both themes. Chat bubbles and compact controls use the UI font stack; long reading/display retains the serif role. No remote font dependency or glass chrome is required.

## Composition and behavior

- One conversation surface: counterpart messages on the left, self messages and editable pending replies on the right. AI analysis, direction choices and next-step advice are identified as advice within the thread.
- A small header selects the counterpart and opens supplementary actions. No always-visible directory, heat dashboard or questionnaire. The companion field coach follows the owner’s later explicit addition.
- Personal profile, counterpart background and meeting arrangements open only when needed, inside the same conversation. Follow-up messages automatically form raw feedback for the preceding draft. Unknown observations remain unknown; lower-weight directions remain selectable.
- The composer records pasted messages and continues the previous round without separate sent-confirmation or feedback buttons. Eligible complete contexts automatically obtain three direction weights once; a direction click generates that reply. Generated and inferred texts retain their source status; the software does not send messages to WeChat.
- Day/night switching preserves the current conversation and unsaved drafts. Only the theme preference belongs in browser local storage; private profiles, chats, tokens and API credentials do not.
- Local demo stays explicitly fictional and loopback-only, with separate private data. Its automatic session never becomes a public authentication bypass. Public access and personal email delivery remain deferred.

## Acceptance

Check the actual rendered day and night conversation on desktop and narrow mobile sizes. Exercise object selection/intake, profile completion, message insertion, direction selection, editable reply, automatic inferred follow-up/feedback linkage, timing annotations and meeting details. Check keyboard controls, focus visibility, minimum touch targets, overflow, reload and error recovery. Synthetic browser checks use a temporary database and knowledge copy and make no paid calls. Source merge, the live local page and chat effectiveness are separate evidence classes.

## Bubble color amendment — 2026-10-01

The owner explicitly rejected green self-message bubbles. Self messages and editable pending replies now use the Nocturne accent scale: a pale lavender fill in day mode and a brighter blue-violet fill in night mode. The owner also requested obvious differentiation: counterpart bubbles retain the neutral surface, self bubbles remain right-aligned with a distinct label, inline AI cards retain their AI identifier, and pending replies add a dashed outline beside the explicit pending/sent label. This applies to this personal chat product; it does not remove semantic success colors from unrelated surfaces or amend the company standard. Both versions retain legible text, speaker alignment and explicit sent/pending labels.

## Conversation spacing amendment — 2026-10-01

The owner found the spacing and proportions awkward. Message groups now use a 12px gap and a 3px label-to-bubble gap. Empty direction options consume no space; the AI card has 12px padding and its closed secondary details share a line where space allows. Pending replies place only the editable text inside the accent bubble, with copying and explanation below; earlier manual send and feedback controls were removed by the subsequent owner correction. Reply height follows the content where supported, with a two-row editable fallback and a 240px cap; long text remains scrollable and manually resizable. Day/night speaker colors, explicit pending labels and 44px controls remain in place.

## Natural follow-up and timing amendment — 2026-10-01

Three direction cards remain visible in all states, with actual recommendation percentages when available and no invented fallback weights. Automatic analysis is bounded to a complete current context and reads persistent attempts/results; it does not automatically retry failures. Selecting a direction generates that reply. Pasting the next counterpart message atomically links the previous editable draft and an untrusted feedback receipt, preserving inferred-use provenance rather than claiming a verified WeChat send. No separate send-confirmation or feedback button appears. Copy and message-entry times are observable application events; inferred intervals stay labeled as estimates. The requested frequency/interval reminder appears by the composer. Time corrections retain original recorded timestamps and their own declared source.

## Field coach amendment — 2026-10-01

The owner added a companion part named 场外教练, overriding the earlier single-part restriction. Desktop places it beside the simulated conversation; narrower layouts open the same part from the header so the message composer remains available. It monitors the complete topic, initiative, warming/obstacle cadence and evidence, and accepts the user’s proposed plan for explicit evaluation. Routine monitoring shares direction-analysis results; plan evaluation is a separate deliberate model call, bounded by daily budgets and never inserted as a WeChat reply. One round means a complete topic. A 10–20-message topic checkpoint is an experience-based prompt to inspect repetition and engagement, not a fixed boredom threshold. User-corrected timestamps replace the primary visible time and analysis reference, with original entry receipts retained privately.

The owner subsequently requested a concise action guide. The default coach view shows the existing server-derived heat index rounded to the nearest five degrees, followed by three priorities: what to do now, what to avoid, and the recommended conversation direction. This is a provisional interaction index, not a success probability. Insufficient evidence, missing classifications and explicit negative resistance suppress the number; negative resistance also overrides any displayed warming or invitation advice. Coverage counts observed dimensions, not independent messages. Long historical text, its conditions and negations remain intact behind visual previews and the evidence disclosure. The primary direction remains the highest actual recommendation weight, with tied directions marked as alternatives; choosing another direction does not silently redefine the recommendation.

New model instructions request one short current goal, one concrete next action and one evidence-grounded pitfall, preferably within 40 characters each. The optional pitfall field preserves old results; missing historical pitfalls use a labeled generic reminder, never an invented personal trait. Detailed topic analysis, source messages and long plan explanations are collapsed by default. Opening these disclosures does not invoke a model, invalidate caches or consume a trial.

Recorded self wording supersedes an earlier pending AI draft. History stays accessible even with one suggestion; viewing it does not associate it with the next pasted message. A successful fresh matching copy can restore its inferred use through server readback, without a confirmation control. Failed copy recording preserves the composer. Reload restores only server-eligible drafts and any eligible copied edits; the server repeats these checks when recording followup.

## Personal expression learning — 2026-10-01

A small expression-preference entry in 场外教练 opens the existing personal profile editor. Optional details compare the source suggestion and the user's own draft/version, capture why it changed and distinguish current fit from willingness to learn. User-written rules default to inactive candidates. Explicit adoption and stopping/replacing individual rules use the same profile save transaction; no sent-confirmation or feedback control is added. Preference saves preserve message/plan drafts, do not send a WeChat message and do not invoke a model. Later requested inference uses the adopted account preferences. Recorded counterpart responses remain independent and unassessed, with unknown meaning unknown. Errors and stale-save conflicts retain input for recovery.
