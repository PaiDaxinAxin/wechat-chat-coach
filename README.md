# WeChat Chat Coach

Personal project owned by [PaiDaxinAxin](https://github.com/PaiDaxinAxin), maintained in a private repository.

The first stage combines the complete game framework, current and desired expression style, counterpart context and feedback to support online interaction and mutually agreed meetings. Users paste conversations, review suggestions and send messages themselves. Display-profile coaching and offline instruction are deferred.

## Project records

- [Product framework and interview decisions](docs/framework.md)
- [Complete knowledge and preserved game 3.3 source](knowledge/game-system.md)
- [MCP access boundary](docs/mcp-architecture.md)
- [Feedback cleaning contract](docs/feedback-data.md)
- [Development entry and adopted Linear standard](AGENTS.md)

Chinese source knowledge and interviews retain their original language; new engineering records follow the adopted baseline.

## Owner MCP

Requires Node.js >=22. Run `npm ci`, `npm test`, then `npm start`.

The owner stdio entry is intended for the owner's computer. Codex/CloudCode can read the complete knowledge, use the client's stronger model to discuss it, submit feedback and append reviewed supplements. Configuration example: [examples/mcp-config.json](examples/mcp-config.json). Use the actual absolute project path and Node executable. Protocol tests do not establish integration with every host.

Optional server-side tools read `AGNES_API_KEY` from the process environment. Defaults: `AGNES_BASE_URL=https://api.agnes-ai.cn/v1`, `AGNES_MODEL=agnes-3.0-flash`; `AGNES_TIMEOUT_MS` sets the deadline. The [official Agnes documentation](https://www.agnes-ai.cn/zh-Hans/docs/agnes-30-flash) defines the compatible transport. Never put credentials in committed examples. Each model request sends the complete current knowledge; malformed/incomplete responses fail visibly without automatic retries or knowledge truncation.

## Restricted MCP

`npm run start:restricted` starts authenticated HTTP at `http://127.0.0.1:8787/mcp` by default. Supply a private `CHAT_COACH_REMOTE_TOKEN` of at least 32 characters via environment; clients send its Bearer authorization through secure configuration.

Only `coach_classify`, `coach_reply` and `feedback_submit` are available. The knowledge stays on the server and enters only the server-controlled model context. No source reader, search, resources, arbitrary files or owner-mode switch is exposed. The external client's model can organize calls; it cannot directly reason over private text it has not received.

Non-local listening requires explicit `CHAT_COACH_HOST`, `CHAT_COACH_ALLOWED_HOSTS` and `CHAT_COACH_ALLOWED_ORIGINS`. `CHAT_COACH_PORT` and `CHAT_COACH_RATE_LIMIT_PER_MINUTE` configure the development listener. Do not distribute this private repository or expose the owner entry to external users.

Authentication, narrow outputs, size limits, excerpt filtering and development rate limits reduce direct disclosure. They do not guarantee prevention of paraphrasing or learning partial methods through repeated calls. Public hosting, TLS, individual accounts, durable quotas and production acceptance remain future work.

## Classification and feedback

Topic moves are `up` (上切), `down` (下切) and `sideways` (平移), distinct from relational actions. Three weights sum to one and are uncalibrated recommendations, not success probabilities. Heat dimensions preserve unknowns and message evidence references. [examples/chat.json](examples/chat.json) is synthetic.

No real chat effectiveness or classification accuracy is established. The free three-trial and paid questionnaire rules remain product requirements; account/billing enforcement is not implemented.

All submitted feedback is isolated in ignored `data/` as raw, untrusted observations. It never updates knowledge or enters training/evaluation automatically. Provenance validation, deduplication, privacy processing and owner review are required before promotion. A receipt is not a clean sample.

## Knowledge write recovery

Concurrent owner processes use a fixed `knowledge/game-system.md.lock` and expected knowledge hash. A conflict requires re-reading the latest document before reviewing a new append. If a process exits while holding the lock, inspect its PID and creation time, confirm that process has stopped, and remove the abandoned lock locally. The service never automatically deletes an existing lock. Originals remain immutable; temporary and lock files are ignored by Git.
