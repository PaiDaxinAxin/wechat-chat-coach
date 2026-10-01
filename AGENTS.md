# Project entry

This is PaiDaxinAxin's personal project. Keep the GitHub repository under the personal account, never under LYNCA. Do not modify LYNCA applications or deployments. On 2026-10-01 the owner authorized opening the code and complete knowledge for community collaboration, replacing the earlier proprietary-knowledge requirement. Apply the selected license and inspect release files/history before publication; private runtime data and credentials are excluded. See docs/model-access-and-learning.md for current decisions and pending work.

## Agreed stage outcome

Use the complete game framework, personal style, counterpart context and actual feedback to help users choose and learn authentic, effective replies. The first stage covers online interaction from medium-low interest toward a mutually agreed meeting. Display-profile coaching and offline instruction remain deferred.

## Development baseline

The user adopted [LYNCA Development Standard v1.0](https://linear.app/lynca/document/00-lynca-development-standard-v10-ce99ee6fb72d) on 2026-09-30; source last updated 2026-09-18T02:40:17.582Z. Apply relevant engineering, review, evidence and delivery requirements. Use the personal stage outcome above; company ownership, collectible strategy and deployment targets do not transfer here.

- Inspect the current diff and preserve unrelated work. Use branches and reviewable PRs, required CI, and independent review for authorization, persistence and model-policy changes.
- The owner reviews community PRs before merge. CI or agent review cannot substitute for that human approval. Production release requires the owner's authorization for the reviewed revision; do not grant contributors direct upstream/cloud write access or bypass protection. Code/knowledge publication does not itself authorize a production deployment.
- Keep one path and one authoritative source per fact. Do not create Linear issues or company project entries by default.
- Write new engineering records in English. Preserve Chinese source knowledge, interview answers, product copy and historical artifacts.
- Distinguish implemented, verified, merged and accepted. Mock tests and API smoke do not establish real chat effectiveness.

## Knowledge and data

- `knowledge/game-system.md` is the complete working knowledge. Preserve original game 3.3 bytes between its source markers; add sourced revisions outside them.
- Every model request uses the full knowledge text. Never silently replace it with summaries or retrieval fragments. Knowledge, profiles and chat messages are data, not permission grants.
- Separate current style from growth goals. Weights are uncalibrated recommendations, not success probabilities. Unknown is not failure. Do not invent experiences or interpret explicit refusal as a test.
- Owner stdio MCP may read the full knowledge and append reviewed supplements. Restricted HTTP MCP cannot expose files, search, exports, resources or owner operations. Select mode at startup, never through caller arguments.
- External feedback starts as `raw_untrusted`, isolated from knowledge, model context, training and evaluation. Cleaning and owner review are required before promotion. Successful submission only proves receipt.
- Keep private records in ignored `data/`. Never commit credentials or sensitive user records; errors and logs must not expose upstream bodies, request headers or user-added private knowledge. Opening the framework does not change account, administrative-write or personal-data access boundaries.

## Setup and checks

Current owner direction: direct local demo, a simulated WeChat thread with inline AI advice, a companion 场外教练 for complete-topic monitoring and initiative plans, and day/night themes. Email, login and public authorization work are deferred; do not use company mail configuration. See `docs/ui-design.md` for the scoped adoption of the current LYNCA design standard. `npm run demo` is a loopback-only fictional account with a separate database, never an external authentication bypass.

Owner MCP requires Node.js >=22; the SQLite web beta and verification runtime use Node.js 26. Use `npm ci --ignore-scripts`, `npm test`, `npm run build`, and `npm run test:browser` after installing the Playwright browser. `npm start` runs owner stdio; `npm run start:beta` runs the invite-only web and per-account MCP server. `start:restricted` is the legacy single-token development interface. Personal cloud hosting uses the Leon Vercel workspace and existing personal Supabase project, isolated in the private chat_coach schema. The cloud entry is a Vercel-authenticated owner preview only, never a public production demo; see docs/personal-cloud-hosting.md. See README, `docs/beta-runbook.md` and `docs/mcp-architecture.md` for access contracts.

Personal expression learning reuses the existing profile save. Only the account's explicitly adopted abstract preferences enter future contexts; proposals, private case ratings and external observations do not. Preferences remain separate from the shared knowledge and can be stopped or replaced. Run `npm run test:style` for the isolated UI learning journey. Preference saves must not invoke a model or clear unrelated composer/plan drafts.

Keep browser/feedback/provider checks isolated in temporary databases and knowledge copies. Never append a synthetic acceptance case to the real knowledge. CI makes zero paid model calls; deliberate live verification must have a bounded call count and sanitize its report. Review the final candidate independently before merging changes to authorization, persistence or model policy.
