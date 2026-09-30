# Invite-only beta operations

Status: local beta build, browser workflow and real Agnes integration verified on 2026-09-30. Personal cloud hosting remains unselected. Public delivery must pass the external-access gate before this is described as externally available.

## Run the private server

Use Node.js 26. Run `npm ci --ignore-scripts`, `npm run build`, and `npm run beta:admin -- init --username owner`. Initialization creates the owner and writes generated credentials to `data/beta/owner-access.json` with private permissions; it does not print passwords. Read the file locally and sign in. Never commit or send this file to testers.

Set the provider environment securely. The owner's existing configuration is outside the repository at `/Users/paidaxin/.config/wechat-chat-coach/agnes.env`. Start with `node --env-file=/absolute/private/agnes.env src/beta.mjs`. Defaults bind `127.0.0.1:8788`. Environment variables already inherited by Node take precedence over an env file; unset stale `AGNES_API_KEY`, `AGNES_BASE_URL` and `AGNES_MODEL` when deliberately loading this configuration. Override `CHAT_COACH_DATA_DIR` to select a private persistent directory. Do not start multiple server processes against the same database. A service lock is acquired before database initialization; dead-process recovery is serialized. Inspect any abandoned recovery guard before manual removal.

The server serves only the built public assets. Testers never receive the private source repository, Docker image, knowledge directory or deployment credentials. The image is a server installation artifact for the owner.

Sign in as owner, create free or paid-beta invitations in the management view, and distribute individual invitations yourself. A paid-beta grant enables full questionnaires and classifier access; it is not a payment transaction. Free classification has three lifetime successful context analyses. Provider-call budgets are bounded per day and include started attempts even when the upstream fails; failed classification does not consume the three successful trials. Reopening the same context returns its persisted result, and switching reply directions does not invoke classification again.

## Controlled external access

Choose a personally controlled host, mount persistent storage and configure TLS. `CHAT_COACH_PUBLIC_ORIGIN=https://chosen.example` is the exact browser origin, with no path. Set `CHAT_COACH_BETA_HOST=0.0.0.0` only behind that reverse proxy. Do not use an unrelated LYNCA deployment or database.

Build the private server image with `docker build -t personal-chat-coach-beta .`. Run it with a private provider env file and mounted private data directory, listening on localhost of the host behind TLS. The writable knowledge file also requires a persistent owner-controlled mount if owner-approved supplements are promoted in the web administration flow. Containers without a persistent knowledge mount lose promoted supplements on replacement; preserve both database and knowledge in the backup.

The container is an optional packaging path. The 2026-09-30 local build could not fetch the official Node image because the registry request timed out; container execution is not verified by that attempt. The verified demo uses the native Node.js server. Do not treat this Dockerfile as separate hosted acceptance.

A temporary development tunnel is an optional beta transport. It requires the owner's machine and both processes to remain running; its address can change on restart and it is not a production hosting guarantee. [Cloudflare documents Quick Tunnels for testing and development](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Use the exact assigned HTTPS origin in the service configuration and verify registration, authenticated calls and rejected cross-origin requests on that address before sharing it.

## Review feedback and knowledge

Feedback submissions are untrusted receipts. Clean them first, inspect source messages, consent, actual sent text, response, privacy transformations, duplicate/conflict indicators and missing observations. Approve only a suitable cleaned candidate for an explicit purpose, with conditions and limits. Knowledge approval appends a reviewed supplement with traceability; an evaluation approval does not modify knowledge. Neither changes model weights. Keep rejected and uncertain results with their reasons.

## Recovery and backup

Stop the service cleanly before a filesystem backup. Preserve the SQLite database and the full current knowledge together in a private backup; retain the provider configuration separately. Restart with the same data path, then read back a prior account, profile, counterpart, conversation and successful job. Unfinished provider jobs are recovered as failed/unknown; they are not resent automatically. Use the UI to request a new attempt explicitly. Do not reset user trials or delete records to manufacture a successful check.

Delete a counterpart through its authenticated UI to remove associated private records. Any approved, anonymized knowledge already promoted has a separate lifecycle and requires owner review to revise. No private profile/chat records belong in GitHub or global organization memory.
