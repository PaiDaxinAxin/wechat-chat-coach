# ADR-001: Owner and restricted coaching MCP

Status: Accepted access boundary; owner, legacy restricted development and account-scoped beta MCP verified locally. Date: 2026-09-30. Decider: project owner.

2026-10-01 update: the owner chose to publish the code and complete framework under MIT/CC BY 4.0. The earlier proprietary-distribution rationale below is historical. Runtime account isolation and owner write permissions still apply; public source access does not expose another user's profile, conversation, credentials or administrative MCP. See [model-access-and-learning.md](model-access-and-learning.md) and [LICENSING.md](../LICENSING.md). The personal protected cloud preview is recorded in [personal-cloud-hosting.md](personal-cloud-hosting.md).

## Context and decision

The owner wants strong client models to discuss the complete framework, while external users may only call coaching capabilities. Full text placed in an external client's context is already disclosed. Prompts cannot reliably make that disclosure unexportable. The owner therefore accepted server-side model execution for external users, with full access on the owner's computer.

| Surface | Available capabilities | Complete knowledge context |
| --- | --- | --- |
| Owner local stdio | Full read, reviewed append, classify, reply, feedback | Owner's client and optional backend model |
| Restricted authenticated HTTP | Classify, reply, feedback only | Our server-controlled backend model |
| Beta account HTTP `/mcp` | List own counterparts; classify, reply and feedback using stored own context and shared durable quotas | Our server-controlled backend model |

Select mode at process startup; caller arguments cannot change it. Restricted mode registers no owner reader, search, source directory, resources or arbitrary file tools. External clients do not receive a package containing the knowledge.

## Contracts

Load full current UTF-8 knowledge for every backend call. Preserve original bytes; owner appends require the expected version. Topic direction, relational action, observed evidence and uncertainty stay separate. Return validated, short results; never raw provider messages, prompts or full input profiles.

Authenticate before dispatch, enforce Host/Origin policy, size and rate limits, and sanitize errors. The original standalone listener uses one startup token and remains a development interface. The beta listener uses per-account expiring/revocable tokens and authenticated object ownership. Caller arguments cannot replace stored profiles, choose another account or elevate a plan. Classification/reply dispatch uses the web application's persistent jobs, context replay and quota accounting.

Feedback goes to raw isolation, not knowledge or model input. Apply the [cleaning contract](feedback-data.md) before promotion. Unknown tools, malformed outputs, incomplete responses and blocked source excerpts fail closed. Do not retry calls or shorten knowledge automatically.

Web followup receipts associate the previous editable draft with the next pasted counterpart message as `inferred_from_followup`, unknown outcome and no consent. They remain quarantined; they do not become confirmed sending through an MCP call. Provenance and user-reported versus application-recorded time sources stay in the shared model context. Slow timing is only one heat signal.

Fresh beta jobs preserve immutable private input/choice snapshots and a full server-side knowledge archive per hash. Ordinary account clients receive neither case snapshots nor knowledge text or archive paths. Legacy jobs retain an explicit missing-context state. Cache identity includes context/protocol version and provider model as well as complete input and knowledge hash. The beta account MCP still has only its four listed tools; the new web followup/copy/time-edit/manual-plan routes do not add owner, export, resources or arbitrary-context capabilities.

Explicitly adopted account expression preferences enter the shared stored coaching context as bounded abstract rules, separate from current style and growth goals. Their effective identity participates in cache and in-flight validity. Private style cases, unadopted proposals, self-ratings and response observations remain excluded; adopting a preference does not promote feedback or change shared knowledge. The existing account MCP tools read the server-selected rules during inference and gain no new rule/profile-write authority.

Exact-excerpt filtering is supplementary. The design prevents direct source reads, but cannot guarantee resistance to inference, paraphrasing or extraction through repeated calls.

## Alternatives and release boundary

Full text to clients would enable their chosen models to reason directly but disclose the asset. Source snippets would disclose selected text and allow accumulating more through calls. Server-controlled reasoning preserves the external access boundary; local owner use keeps unrestricted direct reasoning.

Verify actual SDK tool listing/calls, owner full reads, unauthorized HTTP rejection, missing restricted read tools, feedback isolation, version conflicts and failure responses. Only synthetic records belong in tests. Bounded Agnes smoke verifies transport/format, not conversational effectiveness.

The beta implements individual accounts, private SQLite storage, persistent quotas, recovery and owner review. Before describing it as externally available, verify an exact HTTPS entry against the merged candidate. Personal cloud hosting remains unselected. Real-case evaluation and broader semantic extraction testing remain separate from local protocol tests; output filtering cannot guarantee prevention of method reconstruction.
