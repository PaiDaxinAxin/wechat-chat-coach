# Model access, open-source scope and reviewed improvement

Status: next-stage specification, 2026-10-01. The owner chose to open both code and complete knowledge for community collaboration, with MIT for code and CC BY 4.0 for knowledge. Data-contribution policy remains pending. This document does not itself enable data contribution, per-user model credentials, payments, donations or training.

## Owner direction

- Organize and clean user conversation data to improve the assistant over time, described by the owner as RSI/self-iteration.
- Plan an open-source release. Users bringing their own model API pay the provider themselves and are not charged by this product; voluntary appreciation is optional.
- Charge users who choose the official model service. Account access, model usage, data contribution and donations must remain independent choices.
- Preserve the existing complete-context and reviewed-knowledge approach. The owner explicitly replaced the earlier core-knowledge secrecy requirement with full publication of code and knowledge. This does not authorize publication of private conversations, profiles, account credentials or runtime records.

Open source permits commercial use and sale; charging only for the official service is a product choice, not a condition imposed by open source. See the [Open Source Initiative FAQ](https://opensource.org/faq#selling). The repository contains the complete knowledge in current files and Git history; that content is intentionally in release scope. License scope is recorded in [LICENSING.md](../LICENSING.md). All reachable release history needs inspection for private data and credentials before visibility changes.

## Goals and boundaries

The next stage should let a user understand who supplies and bills each model call, retain the ordinary paste-and-reply interaction, and improve reviewed rules using evidence with explicit permitted purposes. It must preserve complete selected knowledge and recorded context rather than silently truncate them to fit a cheaper model.

The first improvement loop changes reviewed cases, prompts, rules and evaluations. It does not retrain model weights or autonomously deploy its own changes. We do not describe collection alone as learning. Public release and its licenses are authorized; publication follows release verification. Real payment collection and shared user-data processing await their separate decisions.

## Existing implementation and gaps

| Area | Present capability | Required next work |
| --- | --- | --- |
| Model connection | `src/coach.mjs` accepts a server/owner-configured compatible endpoint, key and model through environment configuration; one configured provider serves the server. | Per-account or local-owner selection, credential lifecycle, capability checks, route-aware caching and distinct official/BYOK budgets. This is not already an end-user BYOK feature. |
| Complete context | Full knowledge, saved account profile and all recorded messages are captured; results and versions are traceable. | Distribute the full approved public framework and knowledge. Preserve privacy and account isolation for individual profiles and chats. User-added unpublished knowledge remains under that user's control. |
| Feedback | Raw quarantine, provenance checks, common identifier redaction, duplicate checks and owner review for knowledge/evaluation purposes. | A separate contribution choice and admission boundary, stronger context-level de-identification, withdrawal, purpose-specific consent receipts and a reviewed release process. |
| Feedback visibility | Automatic follow-ups are stored with `consent:false`; the owner feedback view can nevertheless read raw records and full case snapshots. | Do not present the existing consent flag as a default-private contribution feature. Non-contributed service records must not enter the shared research queue or its reviewer detail endpoint. |
| Knowledge publication | Current owner knowledge approval can immediately append to active knowledge. | Separate candidate approval from evaluation and an explicit versioned release for the proposed improvement loop. |
| Commercial service | Free/paid beta plans and call-count limits; full questionnaire/classifier have existing plan gates. | Provider billing identity, usage receipts and a real payment entitlement model. Paid beta invitations are not payments. |

The existing contracts remain active until an implementation explicitly changes them; this document does not silently replace current authorization or retention behavior. See [feedback-data.md](feedback-data.md), [beta-contract.md](beta-contract.md) and [personal-cloud-hosting.md](personal-cloud-hosting.md).

## Accepted open-source scope and provider boundary

There is an unavoidable boundary: the endpoint receiving a full prompt receives the full knowledge. A user-controlled endpoint can simply record it. Even with an allowlisted endpoint, prompt visibility depends on the user's provider account and provider logging. Keeping the HTTP request on our server does not by itself hide that prompt from the provider/account owner. Output filtering and MCP restrictions cannot prevent exposure at the input endpoint.

The owner chose open code plus open complete knowledge after this limitation was explained. One public codebase should support self-hosting, user-supplied compatible models and the full public framework. Official hosting adds managed model service, not a secret version of the core game framework. Do not create a restricted replacement knowledge base or a parallel closed-core product.

Prepare a reviewed public release from approved code/content, including fixtures, screenshots, prompts, documents, generated assets, source maps and dependency notices. Excluding a file from the latest tree does not remove it from Git history. Inspect all relevant history before making the existing personal repository public. Keys, real chat/profile records, private contributions and deployment configuration are excluded. Public code does not make the live owner workspace or administrative APIs public.

Community members may propose code fixes, terminology clarifications, counterexamples, evaluation cases and knowledge changes. Proposals should include provenance and applicability. Public issues/PRs use fictional or safely publishable examples only; do not solicit raw private conversation dumps. Maintainers review changes before adoption. Source openness neither proves a submitted case true nor grants permission to centralize users' local chats.

The owner further specified that community changes must arrive as PRs and receive his review; contributors cannot push to the official production service. `.github/CODEOWNERS` assigns review to PaiDaxinAxin. Protect the default branch with required checks/review and no force pushes; production authorization is a separate owner action. See [CONTRIBUTING.md](../CONTRIBUTING.md). Existing CI contains no deployment job or real service secrets.

## Proposed model contract

- Resolve a connection on the server from the authenticated account or from the local owner's private configuration. Requests select an authorized connection ID, never an arbitrary account, payment plan or server-owner credential.
- First support the existing compatible chat/function-result transport, not a claim of compatibility with every API. Check structured output, full-context capacity and image capability separately. A text-only model can still handle text; screenshot analysis must explain the missing capability rather than silently bill another model.
- Store hosted credentials encrypted with a server-managed key, never in conversation records, audit fields, URLs, browser persistent storage or export bundles. Provide replacement/removal; return masked metadata only. Local self-hosting can use owner-managed environment/secret configuration. Hosted deployment egress needs explicit provider restrictions, including redirect and network-address handling.
- Include provider/endpoint identity, model, connection revision, knowledge version and protocol revision in job/cache identity. Never reuse a result across different routes solely because a model name matches. No raw API key or reversible secret enters a cache key or snapshot.
- BYOK calls do not consume official prepaid balance or the official three-trial classifier allocation. General anti-abuse and concurrency limits are still allowed. Whether the existing full questionnaire gate also becomes available with BYOK should follow the owner's free-software decision explicitly; do not repurpose a user's account as `paid` just to bypass it.
- No silent official-model fallback after a BYOK timeout, quota error, unsupported image or insufficient context. A user must choose an official billable call before it occurs. Complete knowledge/history is not truncated to conceal an unsupported model.
- Official usage receipts identify route, operation, model, knowledge version, provider-reported usage when available and charge state. Unknown usage is not zero. Requests, callbacks and retries must not double-charge; ambiguous provider outcomes require reconciliation, not blind retries.

## Contribution and reviewed improvement

Proposed default, pending owner choice: private coaching remains usable without contributing anything. Hosted service storage needed to serve the user's own conversations is a separate purpose from shared research, evaluation or training. Local/self-hosted use has no automatic central transcript upload.

For an opted-in contribution, use one admission path:

`private record → explicitly contributed raw record → cleaning/quarantine → owner-reviewed candidate → held-out evaluation → explicit release`

Each contribution needs a versioned permission receipt with account, scope, allowed purpose and time. Knowledge improvement, evaluation and future parameter training are distinct purposes; approving one does not authorize the others. Donation, paid service and BYOK selection do not imply contribution. User participation does not make unnecessary identifying details about the counterpart suitable for a shared dataset.

Cleaning should retain enough context to judge the whole topic and background while removing contact information, names, precise locations, account identifiers and unnecessary sensitive details. Use consistent pseudonyms within the case so that removing identifiers does not reverse speakers or destroy sequence. Preserve uncertainty, actual/user-corrected timing provenance, which advice was offered, which wording was actually recorded, what was inferred, and which response was observed. Uploaded images remain transient under the current contract; no future image training use is implied by screenshot support. Model-assisted cleaning produces candidates only and must use a route permitted for that data purpose.

Reuse current provenance/deduplication/quarantine primitives. Extend cleaning to the full contributed context, not merely the short outcome fields. Keep positive, negative and unknown outcomes; no reply or a single emoji is not a verified failure. A copied draft is not verified delivery. Inferred follow-ups retain their uncertainty and cannot be laundered into confirmed training evidence. Do not restore a mandatory “confirm sent” or “record feedback” button in normal chat to make the dataset look cleaner. Evidence review belongs in the optional contribution/reviewer workflow.

For each proposed rule change, retain source cases, conditions, counterexamples, uncertainty, knowledge/prompt/model versions and affected behavior. Use a fixed held-out set separated by conversation and person, so parts of one interaction do not appear on both sides. Evaluate complete-context use, style fit, correct boundaries and appropriate reply/wait decisions as separate outcomes. The system's own heat score is not an independent success label, and an unselected alternative has no observed counterfactual result. Do not optimize on an asserted real-world intimate outcome or treat model agreement as proof of causation.

The owner releases a reviewed candidate only after evaluation, using the existing version/CAS safeguards. Keep a previous release available for rollback; any regression or withdrawn source must stop admission into new releases. Autonomous prompt changes, automatic KB promotion and model-parameter training remain off in this first stage.

Withdrawal must stop new collection/promotion promptly, block stale queued workers using the consent revision, and remove eligible contributed raw/cleaned/export copies according to a documented retention policy. Private-conversation deletion and contribution withdrawal are separate visible actions. Track lineage into candidate datasets and knowledge versions. Existing immutable archives and append-only supplements cannot truthfully promise immediate erasure; implement invalidation/redaction and retention handling before opening external contribution. Do not promise reversal of third-party processing or already-trained model weights.

## Pricing and appreciation

| Mode | Product charge | Other cost |
| --- | --- | --- |
| User-supplied model | Free software/model connection under the agreed edition scope | The user pays their provider, or operates their local model. Hosted storage, cleaning and support still cost the project; set service limits transparently. |
| Official model service | Paid usage/service; packaging and prices undecided | The project pays provider and infrastructure costs. Charge state follows durable usage receipts. |
| Appreciation | Optional support, with no feature gate or contribution permission | Payment channel and recipient are not configured. |

A small optional appreciation entry can live in settings/about, without interrupting chat or implying charity/tax treatment. Until a real personal payment destination is selected, do not ship a fake checkout or collect money. Do not use company merchant, email or financial configuration. The current private Vercel owner preview is not yet a public multi-user paid service.

## Delivery sequence and acceptance

1. **Resolve scope:** code and complete knowledge are open under the selected MIT/CC BY licenses. Decide whether contribution is opt-in or postponed to owner-only cases. Select payment/support destinations later, before enabling collection.
2. **Model access:** implement one shared provider adapter and separate route entitlements. Prove with isolated two-account tests that keys, cache entries, budgets and provider failures do not cross accounts, that BYOK incurs zero official charge, and that no private knowledge can reach a forbidden endpoint. Verify the complete-context/capability failure path.
3. **Contribution admission:** prove zero shared-queue visibility or model-assisted research calls for non-contributors, revoked consent blocks queued work, deletion/withdrawal handles derived copies, and inferred outcomes stay unverified. Keep existing account coaching functional while participation is off.
4. **Reviewed improvement:** compare a candidate with the current version on a frozen set, record coverage and unknowns, reject boundary regressions and demonstrate release/rollback. Add real provider tests only with a bounded authorized call count; synthetic tests are not evidence of better real conversations.
5. **Official service launch:** verify official billing and an optional personal appreciation link before making either available. The licensed source and full knowledge can be published independently after their file/history review; publication does not need to wait for billing or authorize production access.

Initial measurable gates are zero unintended official charges for BYOK, zero shared contributions without their required permission, zero cross-account/cache/secret exposure in the acceptance cases, and a source receipt plus release record for every promoted rule. Report model success rate by provider/capability, failure cost, unknown-outcome coverage and cost per successful operation. Adoption, donation conversion and actual coaching improvement have no baseline yet; do not invent percentage targets or claim improvements from collection volume.

## Open decisions

- **Resolved by owner:** full code and complete knowledge are open; community collaboration is welcome.
- **Resolved by owner:** MIT code and CC BY 4.0 knowledge, allowing commercial use and modification with the relevant notices/attribution. Neither requires every user to submit a PR to this project. See the [MIT license](https://opensource.org/license/mit) and [CC BY](https://creativecommons.org/licenses/by/4.0/) terms.
- **Owner, blocking external contribution:** optional user contribution by default off, or owner-only cases for now?
- **Owner, before commercial launch:** official pricing/usage package, personal payment provider and appreciation destination.
- **Engineering, before contribution launch:** storage/retention/withdrawal across immutable archives, reviewed candidate release mechanics and least-privilege research access. These are implementation work, not already shipped assurances.
