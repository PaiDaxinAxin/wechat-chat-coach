# Internal beta contract

Status: implemented; local synthetic browser and bounded Agnes integration verified. Personal project; 2026-09-30. External access is a separate delivery gate in the acceptance matrix.

The application has a direct local demo and a retained invited-user mode. The owner currently deferred email, login and public authorization work and requested one simulated WeChat thread with inline AI advice and day/night themes. The same server owns profiles, conversation history, quotas, calls, untrusted feedback and review. Every provider call contains the complete current source knowledge and all approved supplements. No client bundle contains knowledge or credentials.

## User journey

Local demo opens a fixed fictional profile and conversation with no login or onboarding barrier, using a dedicated private database. It stays loopback-only and disables login, registration, management and HTTP MCP routes. Edits survive reload and restart. It never invokes a model automatically at startup or when recording a message.

In retained invited-user mode, an owner issues a single-use free or paid-beta invite. Registration stores a password hash and creates an isolated account. The user fills a short custom questionnaire and real background/style/growth goals; paid accounts may fill the full questionnaire. The user creates counterpart records with meeting channel, app profile or offline scene, previous rounds and background, then adds self/other messages. Each message is editable/deletable. Suggestions are editable and copyable; actual sent versions and later observations are recorded separately. Concrete meeting arrangements have their own state. The header selector marks the three strongest supported interactions; heat evidence and supplemental forms open inside the same thread. Explicit negative resistance recommends pausing. No display-profile or offline course is included.

Free classification has three lifetime successful context analyses. A replay of the same context or switching direction does not consume another classification trial. Failed classifications do not consume successful classification trials. Reserved concurrent calls cannot overspend remaining trials. After exhaustion, generation runs directly without a classification call or fabricated weights. Paid-beta access is owner-granted for testing; this is not a payment processor. Both tiers have configurable bounded provider-call budgets that count started attempts, including provider failures.

## API shared by web UI and server

All JSON responses use `{data: ...}`; failures `{error: {code, message}}`. Cookies carry the session; mutations also require `x-csrf-token` from `/api/me` and same-origin requests. Register/login are same-origin and rate limited. No client-supplied role, plan or user ID grants authority.

- `GET /api/meta` → `{name, questionnaires: {short, full}, localDemo:{enabled,synthetic}, privacy}`. Each questionnaire item: `{id, text, dimension, reverse?}`; choices 1–5.
- Local demo only: `POST /api/demo/session` with the strict empty object `{}` creates the fixed fictional session and returns `{user,csrfToken,counterpartId,synthetic:true}`. Caller identity fields are rejected. Ordinary invited mode returns 404. Loopback socket, Host, Origin and proxy-header checks precede session creation.
- `POST /api/register` `{invite, username, password}` → session and `{user, csrfToken}`.
- `POST /api/login` `{username,password}` → `{user,csrfToken}`; `POST /api/logout`.
- `GET /api/me` → `{user:{id,username,plan,role},csrfToken,profile,quota:{classificationRemaining,providerRemaining}}`.
- `PUT /api/profile` `{background,style,growthGoals,relationshipGoal,questionnaire:{kind:'short'|'full',answers:{[id]:1..5}}}` → `{profile}`. Full answers rejected for free users.
- `GET /api/counterparts` → `{counterparts:[{id,alias,channel,rounds,updatedAt,heat}],topThree:[id]}`.
- `POST /api/counterparts`; `PUT /api/counterparts/:id`: `{alias,channel:'app'|'offline'|'other',appProfile,offlineScene,background,rounds}` → `{counterpart}`.
- `GET /api/counterparts/:id` → `{counterpart,messages,suggestions,classification,heat,meeting}`; `DELETE` removes the user's record and associated private data.
- `POST /api/counterparts/:id/messages` `{speaker:'self'|'other',text}` → `{message}`; `PUT /api/counterparts/:id/messages/:messageId` same body; `DELETE` removes it. New/changed context invalidates stale judgments.
- `POST /api/counterparts/:id/classify` `{requestId}` → `{classification,heat,cached,quota}`; no provider call when quota is unavailable.
- `POST /api/counterparts/:id/reply` `{requestId,direction?:'up'|'down'|'sideways',intent?}` → `{suggestion:{id,reply,reason,action,styleNote,direction,knowledgeHash},cached,quota}`.
- `POST /api/counterparts/:id/sent` `{suggestionId,actualSentText}` → `{message}`; this records manual sending, never sends to WeChat.
- `PUT /api/counterparts/:id/meeting` `{status:'none'|'proposed'|'alternative'|'confirmed'|'declined',time,place,note}` → `{meeting}`. Confirmation requires time and place.
- `POST /api/counterparts/:id/feedback` `{suggestionId,actualSentText,counterpartReply,observation,kind:'positive'|'pitfall'|'uncertain',consent:boolean}` → `{id,stage:'raw_untrusted'}`. No raw submission enters model context or source knowledge.
- Owner only: `GET /api/admin/feedback`, `POST /api/admin/feedback/:id/clean`, `POST /api/admin/feedback/:id/review` `{decision:'approve'|'reject',purpose:'knowledge'|'evaluation',conditions,limits,note}`. Cleaning preserves raw data and records transformations/missing evidence; approval requires a cleaned, permitted candidate, reviewed conditions and limits. Review is not model-parameter training.
- Owner only: `POST /api/admin/invites` `{plan:'free'|'paid'}` → `{invite}`; `PUT /api/admin/users/:id/plan` `{plan}`. Never expose these to testers.
- Owner only: `POST /api/admin/users/:id/mcp-token` → one per-account, expiring token; issuing another revokes the previous token. The account MCP at `/mcp` exposes only counterpart listing, classification, reply and feedback; it shares stored contexts, object ownership and persistent quotas with the UI.

## Persistence and exposure

Use one Node.js 26 server and SQLite database in an ignored/private data directory, with transactional quota reservations and per-account object ownership. Runtime and backup files are never published to GitHub. The build assembles only public assets; a private server installation includes the source knowledge. Deployment requires a controlled personal host, persistent volume and TLS. Owner stdio MCP remains available locally; restricted MCP retains its limited interface.

Authoritative verification includes browser registration → profile → counterpart → messages → classification → chosen reply → sent record → feedback, two-account isolation, paid/free permissions, quota replay/concurrency, failure recovery, restart persistence, complete knowledge input, owner cleaning/review and original-byte preservation. Synthetic cases prove workflow reliability, not real chat effectiveness.
