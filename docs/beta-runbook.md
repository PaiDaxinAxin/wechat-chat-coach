# Invite-only beta operations

Status: local beta build, browser workflow and real Agnes integration verified on 2026-09-30. Personal cloud hosting remains unselected. Public delivery must pass the external-access gate before this is described as externally available.

## Run the private server

### Current owner demo

The owner currently wants direct local access and has deferred email, login and public authorization work. After building, use `npm run demo` (or `node --env-file=/absolute/private/agnes.env src/beta.mjs --demo`) to enter a fictional, paid-demo account automatically. It binds only loopback, refuses a public origin/proxy request, and keeps a separate database under `data/local-demo` unless `CHAT_COACH_DATA_DIR` names a dedicated private demo directory. Do not reuse the invited-user database. Server bootstrap makes zero provider calls. Opening an eligible complete conversation or pasting a new counterpart message may automatically make one budgeted classification call; with no free trials, the UI uses one direct reply call. Existing current-context attempts, including failures, prevent automatic retries after reload. User-requested retry, direction replies and plan assessments are explicit budgeted actions.

The owner's current data path is `/Users/paidaxin/.local/share/wechat-chat-coach/local-demo`; Agnes configuration remains outside the repository. The initialization receipt contains no password. Reload and restart retain user edits and deletions. Registration, login, management and HTTP MCP endpoints are unavailable in demo mode. Owner full-access stdio MCP remains a separate local process. No company sender or mail credential is used.

### Standard invited mode

Use Node.js 26. Run `npm ci --ignore-scripts`, `npm run build`, and `npm run beta:admin -- init --username owner`. Initialization creates the owner and writes generated credentials to `data/beta/owner-access.json` with private permissions; it does not print passwords. Read the file locally and sign in. Never commit or send this file to testers.

Set the provider environment securely. The owner's existing configuration is outside the repository at `/Users/paidaxin/.config/wechat-chat-coach/agnes.env`. Start with `node --env-file=/absolute/private/agnes.env src/beta.mjs`. Defaults bind `127.0.0.1:8788`. Environment variables already inherited by Node take precedence over an env file; unset stale `AGNES_API_KEY`, `AGNES_BASE_URL` and `AGNES_MODEL` when deliberately loading this configuration. Override `CHAT_COACH_DATA_DIR` to select a private persistent directory. Do not start multiple server processes against the same database. A service lock is acquired before database initialization; dead-process recovery is serialized. Inspect any abandoned recovery guard before manual removal.

The server serves only the built public assets. Testers never receive the private source repository, Docker image, knowledge directory or deployment credentials. The image is a server installation artifact for the owner.

Sign in as owner, create free or paid-beta invitations in the management view, and distribute individual invitations yourself. A paid-beta grant enables full questionnaires and classifier access; it is not a payment transaction. Free classification has three lifetime successful context analyses. Provider-call budgets are bounded per day and include started attempts even when the upstream fails; failed classification does not consume the three successful trials. Reopening the same context returns its persisted result, and switching reply directions does not invoke classification again.

The current thread workflow pastes the counterpart's words, shows three uncalibrated direction percentages, and lets the user edit/copy a reply. Pasting the next counterpart message associates the captured previous draft without a sent-confirmation or feedback button. The backend writes that pair atomically with `inferred_from_followup` provenance and unknown, nonconsenting raw feedback. It does not assert that a copied draft was sent or that the next message proves attraction, resistance or failure.

Message frequency and intervals are considered alongside the other heat dimensions. The clipboard receipt→paste interval is an application estimate; a preparation→paste fallback is weaker. The user can annotate a past WeChat time for display/analysis while the original recording time remains intact. Both annotated self/other times yield a user-reported interval, still without platform verification. Time edits invalidate stale analysis and require an explicit new analysis; they do not rewrite immutable cases or automatically call a model.

The side coach's current-topic/leadership observation comes from the same classification call. Manual plan assessment uses one native provider call, shared daily limits, and no free classification trial. It is stored separately from WeChat replies. Full topic rounds and A/B/C interpretation are defined in the complete knowledge; no hard message-count countdown or automatic private escalation is implemented.

## Controlled external access

Choose a personally controlled host, mount persistent storage and configure TLS. `CHAT_COACH_PUBLIC_ORIGIN=https://chosen.example` is the exact browser origin, with no path. Set `CHAT_COACH_BETA_HOST=0.0.0.0` only behind that reverse proxy. Do not use an unrelated LYNCA deployment or database.

Build the private server image with `docker build -t personal-chat-coach-beta .`. Run it with a private provider env file and mounted private data directory, listening on localhost of the host behind TLS. The writable knowledge file also requires a persistent owner-controlled mount if owner-approved supplements are promoted in the web administration flow. Containers without a persistent knowledge mount lose promoted supplements on replacement; preserve both database and knowledge in the backup.

The container is an optional packaging path. The 2026-09-30 local build could not fetch the official Node image because the registry request timed out; container execution is not verified by that attempt. The verified demo uses the native Node.js server. Do not treat this Dockerfile as separate hosted acceptance.

A temporary development tunnel is an optional beta transport. It requires the owner's machine and both processes to remain running; its address can change on restart and it is not a production hosting guarantee. [Cloudflare documents Quick Tunnels for testing and development](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Use the exact assigned HTTPS origin in the service configuration and verify registration, authenticated calls and rejected cross-origin requests on that address before sharing it.

## Review feedback and knowledge

Feedback submissions are untrusted receipts. Clean them first, inspect source messages, consent, actual sent text, response, privacy transformations, duplicate/conflict indicators and missing observations. Automatic followup observations have inferred sending and no training/evaluation consent; cleaning keeps them quarantined and review cannot promote them. The compatibility internal sending/feedback APIs are not a required user flow and still record only user claims. Approve only a suitable separately cleaned candidate for an explicit purpose, with conditions and limits. Knowledge approval appends a reviewed supplement with traceability; an evaluation approval does not modify knowledge. Neither changes model weights. Keep rejected and uncertain results with their reasons.

Fresh jobs capture immutable complete input and choice/model metadata at reservation. Owner review can recover the case as it existed when the suggestion was generated. Legacy cases with missing snapshots remain `legacy_incomplete`. Full knowledge versions are stored privately once per hash; ordinary browser and account MCP clients have no archive or case-export endpoint. Snapshot JSON never embeds the full knowledge text. Do not expose the data directory through a reverse proxy or static file server.

## Recovery and backup

Stop the service cleanly before a filesystem backup. Preserve the SQLite database, private `knowledge-versions/` archive and full current knowledge together in a private backup; retain the provider configuration separately. Restart with the same data path, then read back a prior account, profile, counterpart, conversation and successful job. Unfinished provider jobs are recovered as failed/unknown; they are not resent automatically. Use the UI to request a new attempt explicitly. Do not reset user trials or delete records to manufacture a successful check. Changes to model input/output policy bump the context/protocol identity; changing the provider model also invalidates cached judgments without altering old snapshots.

For new `INVALID_MODEL_OUTPUT` failures, private `model_job_failed` audit entries preserve only allowlisted fixed diagnostic categories and bounded schema-field paths. They exclude error messages, invalid values, model/provider bodies and arbitrary path strings, and are not returned in ordinary API/MCP results. Inspect this private evidence before authorizing another bounded manual attempt. Older failures without diagnostics cannot be reconstructed; do not add automatic retries to obtain evidence.

Delete a counterpart through its authenticated UI to remove associated messages, jobs, suggestions, feedback and copy/followup receipts. Archived source knowledge contains no conversation/profile data and has a separate owner-managed lifecycle, as does any approved anonymized supplement already promoted. No private profile/chat records belong in GitHub or global organization memory.
