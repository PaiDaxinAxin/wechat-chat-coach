# ADR-001: Owner and restricted coaching MCP

Status: Accepted access boundary; initial implementation under verification. Date: 2026-09-30. Decider: project owner.

## Context and decision

The owner wants strong client models to discuss the complete framework, while external users may only call coaching capabilities. Full text placed in an external client's context is already disclosed. Prompts cannot reliably make that disclosure unexportable. The owner therefore accepted server-side model execution for external users, with full access on the owner's computer.

| Surface | Available capabilities | Complete knowledge context |
| --- | --- | --- |
| Owner local stdio | Full read, reviewed append, classify, reply, feedback | Owner's client and optional backend model |
| Restricted authenticated HTTP | Classify, reply, feedback only | Our server-controlled backend model |

Select mode at process startup; caller arguments cannot change it. Restricted mode registers no owner reader, search, source directory, resources or arbitrary file tools. External clients do not receive a package containing the knowledge.

## Contracts

Load full current UTF-8 knowledge for every backend call. Preserve original bytes; owner appends require the expected version. Topic direction, relational action, observed evidence and uncertainty stay separate. Return validated, short results; never raw provider messages, prompts or full input profiles.

Authenticate before dispatch, enforce Host/Origin policy, size and rate limits, and sanitize errors. The first listener uses one startup token and process-memory rate limits; it is a development interface, not production multi-tenant authorization/accounting.

Feedback goes to raw isolation, not knowledge or model input. Apply the [cleaning contract](feedback-data.md) before promotion. Unknown tools, malformed outputs, incomplete responses and blocked source excerpts fail closed. Do not retry calls or shorten knowledge automatically.

Exact-excerpt filtering is supplementary. The design prevents direct source reads, but cannot guarantee resistance to inference, paraphrasing or extraction through repeated calls.

## Alternatives and release boundary

Full text to clients would enable their chosen models to reason directly but disclose the asset. Source snippets would disclose selected text and allow accumulating more through calls. Server-controlled reasoning preserves the external access boundary; local owner use keeps unrestricted direct reasoning.

Verify actual SDK tool listing/calls, owner full reads, unauthorized HTTP rejection, missing restricted read tools, feedback isolation, version conflicts and failure responses. Only synthetic records belong in tests. Bounded Agnes smoke verifies transport/format, not conversational effectiveness.

Before public delivery select hosting/TLS, individual identities and tenant storage, persistent quotas, recovery and a fixed evaluation set. Test injection and multi-call extraction against the release candidate. No public service is deployed by this initial implementation.
