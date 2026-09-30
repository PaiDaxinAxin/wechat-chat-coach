# External feedback: clean before use

Status: Accepted ingestion boundary; cleaning/promotion workflow specified, not a production data pipeline. Date: 2026-09-30.

The owner treats external feedback as dirty data. Receipt does not establish truth, a positive chat result or permission to update knowledge. Raw submissions remain outside knowledge, model context, training and evaluation.

## Admission path

`raw_untrusted → cleaning → cleaned_candidate → owner_reviewed → approved_use`

Malformed, unverifiable, contradictory, duplicate or unsuitable records stay quarantined or are rejected with a reason. Cleaning cannot make unsupported claims true; reviewed candidates may still be rejected.

| Check | Required treatment |
| --- | --- |
| Provenance | Validate schema, speaker order, times, request/context reference, knowledge/profile versions and actual sent text. Preserve unknowns; obtain missing evidence or quarantine. |
| Duplicates | Preserve receipt identity; detect retries and matching conversation fragments. Copies must not multiply evidence strength. |
| Privacy | Replace identities with scoped aliases, remove unnecessary sensitive detail and verify permitted use. Keep traceability in restricted storage. |
| Contamination | Treat embedded instructions, fabricated tool results and policy rewrite attempts as untrusted. Separate quoted conversation from interpretation. |
| Outcomes | Separate selected direction, actual sent version, immediate reply, later initiative and concrete meeting arrangement. Unselected actions have no outcome; no observed reply is unknown. |
| Conflicts | Keep alternative explanations and inconsistent reports. Link corrections without silently rewriting original observations. |
| Applicability | Record conditions, proposed mechanism and limits. Keep positive and negative cases; one result is not a universal rule. |

## Promotion

Retain original submissions separately. Record cleaner version, transformations, reasons, unresolved fields, reviewer and approved purpose. Only transformed, reviewed records may enter an authorized downstream use. Knowledge changes must reference the approved record and conditions; raw feedback is never automatically appended.

Separate development examples, future training data and independent holdouts. Avoid splitting fragments of the same conversation/person across comparison sets. Freeze scoring rules; report unknown outcomes and coverage instead of dropping difficult samples to inflate metrics.

Current code receives and isolates raw data only. No trustworthy dataset, cleaning accuracy, model training or automatic promotion is claimed. An owner cleaning/review workflow is the next data step once real records and their provenance are available.
