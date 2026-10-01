# Personal Vercel and Supabase hosting

## Owner direction and exact targets

On 2026-10-01 the owner selected personal cloud hosting, clarified that Vercel means Leon, and authorized reuse of the existing personal Supabase project with clear project labels. Fei and LYNCA resources, credentials, mail and databases are outside this project.

| Resource | Verified target |
| --- | --- |
| GitHub | `PaiDaxinAxin/wechat-chat-coach` (private) |
| Vercel workspace | `Leon using's projects`, slug `leon-using-s-projects`, ID `team_4xgVOBRbMieZAZqBVxbb5Yff` |
| Vercel project | `wechat-chat-coach`, ID `prj_Myp1rpSCT0zKPGGAQL2RnakDV8Q0` |
| Supabase organization | `PaiDaxinAxin's Org`, ID `snqynvmeojjevydxevgv` |
| Supabase project | `PaiDaxinAxin's Project`, ref `eucsgmsalvgqjfeazcyp`, Tokyo, free plan |
| Private PostgreSQL schema | `chat_coach`, explicitly labeled with the personal repository |
| Runtime login role | `chat_coach_app`, no superuser, database creation, role creation, replication or RLS bypass privileges |

The Supabase project was inactive and was restored to `ACTIVE_HEALTHY`. Existing `knowledge_hub`, `public` and Supabase-managed schemas were observed and preserved. This is a shared existing project, not an empty database. The company-scoped Supabase connector cannot administer this target; personal CLI authorization was independently verified before using the official Management API.

## Access and deployment

Website email, signup and login product work remain deferred. The hosted owner workspace is an authenticated Vercel **preview**, with project protection `prod_deployment_urls_and_all_previews`. After Vercel access, the application opens the configured owner workspace without an additional application login page. Anyone granted access through this project's Vercel protection obtains that owner identity. Do not invite external testers into this mode.

`src/cloud.mjs` requires `VERCEL=1`, `VERCEL_ENV=preview`, the unique generated `VERCEL_URL`, and a fixed private owner ID. It rejects production at startup and rejects alternate Host headers, including public production and branch aliases. Forwarded headers cannot select an account or origin. `POST /api/preview/session` accepts only an empty body, requires the exact same origin, verifies the configured owner and creates a Secure, HttpOnly, SameSite cookie. It is absent from normal startup. Existing account CSRF checks and the separate Bearer-authenticated restricted MCP remain active. Local `--demo` retains its loopback-only guard and cannot use the external store.

Vercel Authentication is the outer authorization boundary, not merely a cosmetic login page. Maintain it and verify unauthenticated access before each delivery. Always deploy with `vercel deploy --target preview --scope leon-using-s-projects`; the first deployment of a new Vercel project can otherwise become Production even without `--prod`. The exact unique preview URL is the supported entry. Do not promote this configuration to production or relax its origin checks to support public aliases. A future public beta needs its own account access design.

`vercel.json` serves only `dist/public` and routes API/MCP/health to the function. The complete knowledge and private data never become static assets. Runtime configuration exists only in encrypted preview environment variables: `CHAT_COACH_DATABASE_URL`, `CHAT_COACH_DATABASE_CA`, `CHAT_COACH_PREVIEW_OWNER_ID`, Agnes provider settings and explicit budgets. No cloud password or provider key belongs in the repository or browser.

## Persistence and model execution

The existing API and account MCP await either the local SQLite store or the cloud PostgreSQL store. Explicit migration functions initialize tables; cold starts validate schemas and perform no DDL. Run the account and knowledge migrations before `grantPostgresRuntimeAccess`. The administrator creates the dedicated login role separately. Schema/table privileges and RLS exclude PUBLIC, anon and authenticated clients.

Use the selected project's actual transaction-pooler endpoint. Avoid prepared statements and session-level coordination. Runtime TLS verifies the server certificate and hostname using Supabase's official CA (valid through 2031-04-26); certificate checking is never disabled. Pool size is bounded, idle clients are drained with `attachDatabasePool`, and long model requests never hold a database transaction open.

Immutable complete knowledge versions are addressed by content hash, with one current pointer. Original 3.3 bytes, source hashes and expected-version checks remain enforced. The owner-only `publishPostgresKnowledgeSnapshot` helper publishes reviewed local append-only bytes with an expected cloud hash and exact byte readback; it is not registered as an HTTP or MCP operation. If cloud and local edits diverge, reconcile them explicitly before publication rather than overwriting either history. A model request captures the complete account context consistently, archives its complete knowledge version, reserves quota and deduplicates work durably, then calls the provider outside a transaction. Final context validation and receipt persistence share one short transaction. Knowledge reads in this transaction reuse its connection, preventing pool exhaustion when other instances wait for the shared advisory lock.

Task leases recover only expired jobs; a cold start never fails all running jobs. Uncertain paid calls are not automatically retried. Raw feedback, cleaned review candidates and approved knowledge retain their separate states. The current local SQLite demo and its data are preserved. No existing local chat history has been silently imported into a new cloud owner account.

## Verification and delivery record

Isolated local PostgreSQL tests cover independent instances, quotas, leases, sessions, account boundaries, immutable snapshots, knowledge byte equality, review deduplication, RLS, context changes during generation and four concurrent completion transactions. CI runs these against PostgreSQL 17 and Node 24; existing local/UI suites use Node 26. Synthetic tests and health responses do not prove real model quality.

The first verified candidate is `113632dee78fce1715602a3a00f1d2215d2e275e`, deployed as `dpl_9NDGx7t93396vdEhi9rU56rk6t5L` at `https://wechat-chat-coach-1rvfjevpd-leon-using-s-projects.vercel.app` (Preview, Node 24, `hnd1`). Unauthenticated root and account requests redirect to Vercel protection. Authorized health/meta/owner-session/account checks passed, including wrong-origin rejection. A synthetic counterpart and message were written through the hosted API, read back through a separate database connection, then removed. Runtime access to tables in other personal application schemas was denied. Private source, knowledge, environment and SQLite paths returned 404; unauthenticated account MCP returned 401. Arbitrary API query strings remain rejected; the cloud wrapper removes only Vercel's exact matching rewrite capture.

Cloud knowledge exactly matched all 56,461 reviewed local UTF-8 bytes after G4 publication, hash `faa0b06bcc44111881b7d52ac0caa783e67e18590fc272957138d0618a8512f7`. G3 records context-based topic changes and leaving space; G4 records the owner's direct topic-change example and preference against explanatory transitions. Knowledge publication is independent of the application bundle. The local demo was restarted with its original private data directory after a backup and zero active model jobs; user/profile/counterpart/message/suggestion counts matched before and after.

The `91c9b12c910fb8187dfad5c341582e365b6c312e` follow-up fixes browser-test readiness and persists suggestion insertion order in both adapters. It was deployed as `dpl_7YxyoErEpE7K7CvDWzta8Etr6tPC` at `https://wechat-chat-coach-myym1aeds-leon-using-s-projects.vercel.app`; the same hosted protection, account/origin, private path and independent PostgreSQL readback checks passed again. Its private cloud migration found zero historical suggestions before adding the identity column and verified runtime sequence access. Existing historical rows in other installations cannot have their original tied-timestamp order inferred retroactively.

A bounded one-call Agnes check accepted an inline synthetic PNG screenshot and recognized its Chinese text and emoji. This establishes this gateway input path, not general OCR or relationship-assessment accuracy. Hosted persistence checks made zero provider calls. Browser behavior is established by isolated synthetic journeys; no real dating outcome is claimed. Required GitHub checks and the final reviewed revision are recorded in PR #13 before merge.

References: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Supabase TLS](https://supabase.com/docs/guides/platform/ssl-enforcement), [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js), [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).
