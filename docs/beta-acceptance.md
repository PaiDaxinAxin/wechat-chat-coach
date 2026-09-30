# Internal beta requirement acceptance

Candidate: `feat/private-beta-demo`, built and checked on 2026-09-30. Personal repository: `PaiDaxinAxin/wechat-chat-coach`. This matrix evaluates the complete requested application, knowledge system and MCP; successful MCP calls alone do not complete the beta goal.

## Implemented and locally verified

| Requested outcome | Current behavior | Evidence |
| --- | --- | --- |
| Preserve and expand the original framework | Original 3.3 bytes are immutable inside source markers; current interview additions remain outside them. Approved supplements are append-only, versioned and condition-scoped. | `tests/source.test.mjs`, `tests/knowledge.test.mjs`; original SHA-256 below. |
| Every model call receives the complete framework | Read the full current file, including approved additions, on each new provider call. No summary/retrieval substitution. | `tests/coach.test.mjs`, API/browser exact-text checks and two real Agnes calls. |
| Intake both sides before assisting | Required personal background, style, learning and relationship goals; counterpart channel, app profile or offline scene, rounds, background and messages. | `tests/domain.test.mjs`, `scripts/verify-browser.mjs`. |
| Short/full personal questionnaires | Original 10/30-item forms, all raw answers and question texts retained in context; inferred preference summaries remain hypotheses. Full submission/use requires server-authorized paid access. | Domain, API and browser checks, including downgrade behavior. |
| Multiple counterparts and isolated context | Authenticated object ownership, separate profiles/histories, editable/deletable messages, invalidated stale judgments. | Two-account API/MCP tests and browser journey; deleting an object during a call cannot recreate it. |
| Multi-dimensional heat and top three | Five dimensions with distinct message evidence/unknowns/coverage/confidence; comparable-history trend; up to three supported priorities. Explicit negative resistance pauses; medium-low potential is retained. | Domain and API tests; transparent provisional rules in `docs/questionnaires.md`. |
| Online improvement toward a meeting | Distinguish ordinary interaction, warming, obstacles and invitation readiness. Record proposal, alternative, confirmation or decline; confirmation requires time/place. | Provider schema/prompt review, meeting API tests and browser confirmation flow. |
| Three directions with user choice | Up/上切, down/下切 and sideways/平移; three relative recommendation weights. Lower-weight choices remain selectable and honored. | Coach/domain tests, browser selects down at weight 0.1, real gateway returns three validated directions. |
| Preserve current style and learn | Real current style, learning goals and relationship goal are separate. Replies include a short style explanation. No identity/experience fabrication; a single positive response is not a causal claim. | Complete context tests, prompt/knowledge review and editable browser reply. Personal fit still needs user examples. |
| Free three classifier trials and paid access | Lifetime successful classifications provisionally limited to three. Transactional reservations, context replay, direction changes and failure handling avoid duplicate trial charges. Exhaustion permits direct generation without classification. | API quota, concurrency, replay, restart, failure and direct-generation checks. |
| Bounded beta cost | Account/global daily provider-attempt limits, including started failures; no automatic provider retry. Classification trial counts and provider attempt budgets remain separate. | API budget/day-reset tests; CI uses zero paid calls. |
| Feedback includes the actual sent version | Suggestion, confirmed manual sent record, later response and user interpretation are distinct. Editing a transcript invalidates confirmed provenance. | Domain/API regressions and browser edited reply → manual sent record → feedback. |
| Dirty feedback must be cleaned | Immutable raw isolation; provenance/version checks, deduplication, common PII redaction, obvious injection/conflict quarantine and unknown outcomes. | `tests/domain.test.mjs`, API feedback tests and browser raw-isolation check. |
| Owner review before knowledge/evaluation use | Explicit consent, conditions, limits and designated purpose. Revalidate source at approval; recover an interrupted file/database approval without appending twice. | API recovery/source-change tests and browser clean → review → bounded supplement. Synthetic tests never change the real knowledge. |
| Local full-access MCP | Owner stdio exposes complete read and reviewed append plus coaching/feedback. Registered in the owner's Codex configuration outside the repo. | Actual SDK owner process/full text equality and prior configured-owner Agnes reply. Client tools require a fresh host session after registration. |
| External scoped MCP and private knowledge | Per-account expiring/revocable token, four stored-record coaching tools, same persistence/quotas as UI. No owner/read/search/files/resources/prompts exposed. | `tests/beta-mcp-http.test.mjs`, MCP unit tests; authentication precedes metadata; cross-account calls rejected; token rotation revokes an already connected client. |
| Real, usable web build | Three public assets only; invite register → profile → counterpart → conversation → classify → chosen reply → editable actual sent version → feedback → owner review. Desktop plus 390/320 px; reload persistence and counterpart deletion. | `npm run build`, actual Chromium browser journey; no page errors or horizontal overflow. Native server runs with Agnes configured. |
| Personal ownership and development standard | Private personal remote, separate local project/data/provider configuration; relevant adopted Linear review/CI/evidence rules. | Git remote readback and `AGENTS.md`; company deployments are not used. |

## Delivery and interpretation gates

| Gate | Status |
| --- | --- |
| Local final checks | 101/101 Node tests passed; build and browser journey passed. Mock/synthetic checks establish workflow behavior. |
| Real beta HTTP → Agnes | Two deliberate synthetic calls passed at `2026-09-30T14:51:34.290Z`: classification 14.575 s; reply 3.586 s. Full knowledge equality verified on both; replay made no additional call. |
| Independent review | Non-authors reviewed domain, API/store, MCP, CLI, build and deployment contracts. Provenance, startup recovery, context replay/history and IPv6 findings were fixed and rechecked. Final review/CI remain required before merge. |
| Personal GitHub delivery | Branch/PR/CI/merge is the remaining source-delivery gate; do not substitute a local pass for a successful GitHub check. |
| External tester access | Pending an authorized, exact HTTPS entry and remote browser/authenticated-call verification. The owner has no confirmed personal cloud host and asked to leave that field empty. A running localhost demo is not external delivery. |
| Container packaging | Dockerfile provided as an optional owner installation path; Node image registry fetch timed out. Container execution is not verified. Native Node build/start is verified. |
| Real chat effects and classifier calibration | Not established. Heat thresholds, questionnaire interpretations and weights are transparent initial hypotheses awaiting reviewed real cases. No model-weight training or success-probability claim. |
| Deferred product scope | Display-profile construction, offline instruction/course sales, payment processing, automatic WeChat sending and automatic long-history compaction are outside the current beta. |

Full current knowledge at the live check: 43,716 UTF-8 bytes, SHA-256 `f189f98f3fe7acf536f2b67a61ad3f71ab4b19cd2bc16d5a3bb2a229289e54cd`. Original 3.3 source body: 30,291 bytes, SHA-256 `1da5b778618c20c50f803193050b1aa7163bb9bddc99450f2ee88c226ed8ef67`.

Persist operational evidence privately in ignored `runs/`; never publish credentials, raw profiles/chats or a private access token. Final delivery should name the merged GitHub candidate and actual access environment. Synthetic cases and real provider transport cannot establish the effectiveness of this dating framework.
