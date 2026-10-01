# WeChat Chat Coach

Personal project owned by [PaiDaxinAxin](https://github.com/PaiDaxinAxin). Code is licensed under [MIT](LICENSE); the complete knowledge and identified framework documents use [CC BY 4.0](knowledge/LICENSE.md). See [license scope](LICENSING.md) and [contributing](CONTRIBUTING.md). Personal conversations, profiles, credentials and runtime records are excluded. [Model access and reviewed improvement](docs/model-access-and-learning.md) distinguishes current capabilities from planned features.

The official website uses our server-configured AI provider, with three successful AI replies per day for free accounts and a separate paid tier. Removing hosted bring-your-own-key access does not remove free official access. Service data lives in our backend and may support cleaning and reviewed improvement under the documented data-purpose controls; storing a chat does not make it public or automatically turn it into training data. Public paid access and checkout are not live; free/paid beta labels are not payment processing.

Self-hosting with your own compatible model API uses your provider account and does not charge this project. Configure `AGNES_API_KEY`, `AGNES_BASE_URL` and `AGNES_MODEL` privately; these historical environment names also accept a compatible provider other than Agnes. The provider must support the native function-result format used by this application; image support and full-context capacity are separate requirements. Self-hosters operate their own infrastructure and data; there is no automatic transcript upload to our service or required upstream payment. Community improvements arrive through owner-reviewed PRs. An optional appreciation destination remains unconfigured.

The first stage combines the complete game framework, current and desired expression style, counterpart context and feedback to support online interaction and mutually agreed meetings. Users paste conversations, review suggestions and send messages themselves. Display-profile coaching and offline instruction are deferred.

## Direct local demo

Use Node.js 26. Run `npm ci --ignore-scripts`, `npm run build`, then `npm run demo` with the provider environment configured privately. Open `http://127.0.0.1:8788`. The demo enters a fictional account directly and keeps edits in its own private data directory (`data/local-demo` by default). There is no login or registration step. Opening a complete eligible conversation automatically obtains its context analysis once per context. Durable attempt/result readback prevents repeat calls on reload; failures need explicit retry. Continue the current topic directly, or choose a direction when changing topic. Deliberate plan evaluation uses the same configured provider and complete knowledge.

The UI centers on a simulated WeChat conversation with editable replies, a companion 场外教练 for complete-topic monitoring and initiative plans, and day/night themes; see [the scoped design record](docs/ui-design.md). Three direction choices appear when changing topic or explicitly requesting a change; ordinary replies do not require that choice. Account-owned message annotations preserve explanations separately from the original conversation text. Email, login and public website authorization work are deferred by the owner. Do not use company email infrastructure. Demo startup refuses public origins and nonlocal listening; do not expose it through a public proxy.

The field coach's expression-preference entry reuses the personal profile editor. An optional private case preserves the original suggestion, the user's own version, modification reason, style fit and willingness to practice. User-written rules remain candidates until explicitly adopted; adopted preferences and growth rules apply to subsequent account-scoped coaching and can be replaced or stopped. Saving preferences makes no model call and does not establish that a draft was sent or that it worked. Other people's responses remain separate, unassessed evidence. See [the API contract](docs/beta-contract.md) for the distinction from untrusted external feedback.

## Invite-only web beta

Use Node.js 26. Run `npm ci --ignore-scripts`, `npm run build`, then `npm run beta:admin -- init --username owner`. Read the generated owner credentials locally from the private file reported by the command. Set the provider environment securely and run `npm run start:beta`; the default address is `http://127.0.0.1:8788`.

The owner issues individual free or paid-beta invitations in the management view. Accounts have separate profiles, counterpart records, conversations and persisted jobs. The application includes original 10/30-item questionnaires, topic-change direction choices, evidence-based heat and top-three ordering, editable replies, message annotations, automatic inferred follow-up linkage, user-correctable message times, meeting arrangements, and a raw → cleaning → owner-review feedback flow. A paid-beta grant enables the full questionnaire and classifier; it does not process payments.

Free users receive three new successful sendable AI replies per Asia/Shanghai calendar day across all counterpart records. Concurrent requests reserve slots; completion settles on the request's reservation date. Failures, cached results and wait/pause advice without a sendable reply do not consume that allowance. Paid and owner accounts have no three-reply cap, but provider budgets still apply. This is separate from three lifetime successful classifications: context replays and direction changes do not reclassify, and failed classifications do not consume those trials. After classification exhaustion, direct replies retain complete knowledge and remain subject to the daily reply allowance, without fabricated classifier weights. Classification, plan assessment and image interpretation use their separate existing limits, not the reply allowance. Started provider attempts have bounded daily budgets, including failed calls.

Use [the beta runbook](docs/beta-runbook.md) for startup, private persistent storage, recovery and controlled external access. A localhost address is usable only on the owner's machine. Personal hosting uses the Leon Vercel workspace and the existing personal Supabase project. The owner preview is protected by Vercel Authentication; public signup and external access remain deferred. See [personal hosting](docs/personal-cloud-hosting.md) for the exact targets and access boundary. Open-source distribution of code and knowledge does not grant access to this live owner workspace or its private data.

## Project records

- [Product framework and interview decisions](docs/framework.md)
- [Complete knowledge and preserved game 3.3 source](knowledge/game-system.md)
- [MCP access boundary](docs/mcp-architecture.md)
- [Feedback cleaning contract](docs/feedback-data.md)
- [Proposed open-source, model access and reviewed improvement](docs/model-access-and-learning.md)
- [Questionnaires and provisional heat rules](docs/questionnaires.md)
- [Beta API and account contract](docs/beta-contract.md)
- [Requirement acceptance matrix](docs/beta-acceptance.md)
- [Verification evidence](docs/verification.md)
- [Single conversation design](docs/ui-design.md)
- [Development entry and adopted Linear standard](AGENTS.md)

Chinese source knowledge and interviews retain their original language; new engineering records follow the adopted baseline.

## Owner MCP

Requires Node.js >=22. Run `npm ci`, `npm test`, then `npm start`.

The owner stdio entry is intended for the owner's computer. Codex/CloudCode can read the complete knowledge, use the client's stronger model to discuss it, submit feedback and append reviewed supplements. Configuration example: [examples/mcp-config.json](examples/mcp-config.json). Use the actual absolute project path and Node executable. Protocol tests do not establish integration with every host.

Optional server-side tools read `AGNES_API_KEY` from the process environment. Defaults: `AGNES_BASE_URL=https://apihub.agnes-ai.com/v1` (owner-selected gateway), `AGNES_MODEL=agnes-3.0-flash`; `AGNES_TIMEOUT_MS` sets the deadline. The [official Agnes documentation](https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash) defines the compatible transport. Never put credentials in committed examples. Each model request sends the complete current knowledge and submits its result through one forced function using a mechanically derived JSON Schema; malformed/incomplete responses fail visibly without automatic retries or knowledge truncation.

## Account MCP for beta users

The beta server exposes `/mcp`. An owner issues a separate per-account, expiring Bearer token through the management view. The four available tools are `counterparts_list`, `coach_classify`, `coach_reply` and `feedback_submit`. They operate only on the authenticated account's saved records and use the same quotas and job persistence as the web UI. Caller inputs cannot choose another account, set a paid plan, supply an owner mode or replace the stored profile. Configure the token privately in the client; never put it in a public example.

The server-controlled model receives the complete knowledge; the external MCP client receives bounded suggestions. No source reader, search, resource, file download or owner operation is registered. Authentication, object ownership, Host/Origin policy, output bounds and excerpt filtering reduce direct exposure. Repeated answers can still reveal partial methods; this is not a guarantee against semantic reconstruction.

## Legacy restricted development MCP

`npm run start:restricted` starts authenticated HTTP at `http://127.0.0.1:8787/mcp` by default. Supply a private `CHAT_COACH_REMOTE_TOKEN` of at least 32 characters via environment; clients send its Bearer authorization through secure configuration.

Only `coach_classify`, `coach_reply` and `feedback_submit` are available. The knowledge stays on the server and enters only the server-controlled model context. No source reader, search, resources, arbitrary files or owner-mode switch is exposed. The external client's model can organize calls; it cannot directly reason over private text it has not received.

Non-local listening requires explicit `CHAT_COACH_HOST`, `CHAT_COACH_ALLOWED_HOSTS` and `CHAT_COACH_ALLOWED_ORIGINS`. `CHAT_COACH_PORT` and `CHAT_COACH_RATE_LIMIT_PER_MINUTE` configure the development listener. Do not expose an owner's administrative entry or private configuration to external users.

This single-token development entry is retained for transport tests and local experimentation. Use the account-scoped beta server for invited testers.

## Reply guidance and images

Every newly generated reply includes a topic direction and a separate relationship action, with a short guide for replying in the user's own words. These internal labels do not make every message a topic-change decision: the three direction choices are shown only when a change is needed or explicitly requested. Waiting and pausing show reasons and reentry conditions without creating a sent-message draft. Stored older suggestions keep an explicit missing-guidance label.

An optional message annotation records the user's explanation, such as the intended meaning of a sticker or context behind a sentence. It can be edited or cleared without rewriting the original message, speaker or time. Future complete-context requests include its `user_annotation` source; a note is not verified evidence of the counterpart's intentions and does not grant training consent. Saving it does not invoke a model; old model snapshots remain unchanged.

Paste or select one PNG, JPEG or WebP image up to 1 MB in the composer, optionally explain its meaning, then interpret it into an editable description. Original images are processed transiently rather than saved by this application. AI descriptions and user interpretations retain their separate source labels. Screenshots that may contain both speakers do not automatically imply that a previous reply draft was sent. Emoji also works as ordinary text.

Assessment uses both complete recorded profiles and every supplied saved message, not a last-N window. Missing history remains unknown. Sparse evidence produces no numerical heat score. See [full-context assessment](docs/heat-context.md) for the evidence, timing and trend limits.

## Classification and feedback

Topic moves are `up` (上切), `down` (下切) and `sideways` (平移), distinct from relational actions and A/B/C warming intensity. One round means a complete topic. Three weights sum to one and are uncalibrated recommendations, not success probabilities. Heat dimensions preserve unknowns and message evidence references. [examples/chat.json](examples/chat.json) is synthetic.

Heat has five observed dimensions, distinct message evidence, unknowns, coverage, qualitative confidence and a comparable-history trend. Explicit negative resistance overrides a high score. Rules and recommendation weights remain provisional; no real chat effectiveness or classification accuracy is established.

All submitted feedback starts as raw, untrusted observations in private storage. Pasting a follow-up associates the preceding editable draft automatically, records inferred-use provenance and an unknown outcome, and never silently grants training consent. Copy/entry intervals are estimates; user-corrected times replace the main display/analysis reference while original receipts remain private. Cleaning checks provenance, actual sent versions, duplicates, common identity patterns, obvious instructions, conflicting labels and missing outcomes. An owner reviews permitted candidates with explicit conditions and limits before approving a knowledge supplement or evaluation use. Approval is traceable and repeat-safe; it does not update model weights. Automatic cleaning is conservative and still needs owner inspection.

## Checks

Run `npm test`, `npm run build`, `npx playwright install chromium`, `npm run test:browser`, `npm run test:browser -- --https-proxy`, `npm run test:demo`, `npm run test:style`, and `npm run test:a11y`, `node scripts/verify-reply-guidance.mjs`, and `node tests/verify-image-input.mjs`. The accessibility journey runs all default axe-core rules over desktop and narrow day/night states, and records incomplete results for manual review. CI uses synthetic records and makes no paid model calls. `scripts/verify-live.mjs` is a deliberate, bounded two-call Agnes integration check using a temporary database and the full knowledge; `scripts/verify-style-live.mjs` requires explicit opt-in and attempts one fictional reply using an adopted expression preference. Neither is part of automatic CI. See the acceptance matrix for the distinction between verified local behavior, external delivery and real-chat validation.

## Knowledge write recovery

Concurrent owner processes use a fixed `knowledge/game-system.md.lock` and expected knowledge hash. A conflict requires re-reading the latest document before reviewing a new append. If a process exits while holding the lock, inspect its PID and creation time, confirm that process has stopped, and remove the abandoned lock locally. The service never automatically deletes an existing lock. Originals remain immutable; temporary and lock files are ignored by Git.
