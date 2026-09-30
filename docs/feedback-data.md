# External feedback: clean before use

Status: deterministic cleaning/review domain implemented for the internal beta; not a validated production dataset or a training pipeline. Date: 2026-09-30.

The owner treats external feedback as dirty data. Receipt does not establish truth, a positive chat result or permission to update knowledge. Raw submissions remain outside knowledge, model context, training and evaluation.

## Personal expression preferences

An authenticated user's own expression preferences are separate from evidence about another person's reaction. The private style-learning path stores the user's original/edited expression comparison and self-reported fit, reason and willingness to try. It accepts no outcome, feedback or proof fields and cannot import raw external feedback. A user may explicitly adopt an abstract preference for current expression or future practice, with stated conditions and limits; unadopted cases and proposals never enter the model context. Adoption changes only that account's private preferences, not the game knowledge or model weights. A reply being recorded remains unassessed; it cannot establish success or automatically produce a rule. Any later use of external outcome data still follows the admission and owner-review path below.

## Admission path

`raw_untrusted → clean_candidate or quarantined → owner review → approved_candidate or rejected → explicitly authorized use`

Malformed, unverifiable, contradictory, duplicate or unsuitable records stay quarantined or are rejected with a reason. Cleaning cannot make unsupported claims true; reviewed candidates may still be rejected.

| Check | Required treatment |
| --- | --- |
| Provenance | Require a source receipt, matching stored suggestion, knowledge hash and a matching manual sent record with the self speaker, suggestion ID and actual text. Missing or conflicting records are quarantined. This establishes a user-confirmed record, not independently verified WeChat delivery. |
| Duplicates | Preserve receipt/suggestion IDs separately. Fingerprint canonical actual sent text and counterpart reply, independent of unstable IDs, labels and subjective interpretation. The storage/API layer checks existing fingerprints; the pure cleaner cannot inspect other receipts. Copies must not multiply evidence strength. |
| Privacy | Redact common phone/email/contact-handle/national-ID/explicit-address patterns and caller-provided known identifiers. Preserve transformation kind/count/field, not the removed secret values. Names, unlabeled addresses and indirect identities still need owner inspection. |
| Contamination | Known instruction/policy-extraction patterns trigger quarantine, even when quoted inside a conversation. Do not execute source text. Pattern checks have false positives and cannot establish comprehensive injection safety. |
| Outcomes | Keep proposed reply, actual edited sent version, reported counterpart reply and the user's interpretation separate. Outcomes remain `user_reported`. No reply is unknown; an uncertain observation can be a candidate, but a positive/pitfall label without a counterpart reply is quarantined. Unselected suggestions have no observed outcome. |
| Conflicts | Obvious positive-vs-explicit-refusal or pitfall-vs-explicit-meeting-interest labels trigger quarantine. This is a conservative check, not a semantic truth classifier. Ambiguous or contradictory claims still require human review. |
| Applicability | Require nonempty owner conditions and limits for approval and an allowed purpose. Keep successes and pitfalls; one result is not a universal rule or causal finding. |

## Promotion

Retain original submissions separately. `cleanFeedback` is a deterministic pure function; it never rewrites the raw record, reads files, invokes a model or updates knowledge. It returns the cleaner version, transformations, flags, missing fields, provenance, fingerprint and allowed purposes. A schema-valid candidate without consent may be inspected but cannot be approved for either knowledge or evaluation.

`reviewFeedback` requires an owner-authorized API caller. The domain function checks the candidate stage, consent, purpose, conditions and limits; it does not grant ownership. Approval text is checked for known embedded instructions and common PII is redacted. The caller retains audit identity and timing in private storage. Rejected/quarantined records remain traceable, rather than disappearing from the sample history.

`buildFeedbackKnowledgeSupplement` constructs a supplement only for an approved knowledge candidate with the expected provenance. It rechecks candidate/review text for known instruction patterns and redacts known identifiers and common PII before formatting the bounded record. The builder does not append anything or train model parameters. The owner API decides whether and when to call the existing version-protected append operation and records its source/conditions. Evaluation approvals stay outside the knowledge builder. Knowledge changes must reference the reviewed receipt, original knowledge hash, conditions and limits; raw feedback is never automatically appended.

Exact-content fingerprints can conservatively flag two unrelated generic exchanges as a possible duplicate. Preserve both sources for owner inspection; do not claim duplicate detection proves fabrication. The current cleaner cannot verify the truth of a reported response, independently inspect WeChat, resolve every contradiction or remove every indirect identity. Safe downstream use requires the owner's review of the complete candidate and its intended purpose.

Separate development examples, future training data and independent holdouts. Avoid splitting fragments of the same conversation/person across comparison sets. Freeze scoring rules; report unknown outcomes and coverage instead of dropping difficult samples to inflate metrics.

Domain tests cover schema admission, manual-sent matching, knowledge version, immutable raw input, identity-independent fingerprints, redaction patterns, injection/conflict/missing-evidence quarantine, unknown outcomes, consent gates, review conditions and limits, and the safe supplement builder. API persistence, account authority and actual append integration are verified separately. No trustworthy real-world dataset, cleaning accuracy, effect calibration or model-parameter training is claimed.
