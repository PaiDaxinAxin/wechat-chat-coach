# Initial verification — 2026-09-30

This record describes development evidence, not a deployed service or verified chat effectiveness.

| Check | Result and scope |
| --- | --- |
| `npm test` on Node.js 26 | 36/36 passed; deterministic/mock contracts, actual MCP SDK connections, access boundaries, failures, raw feedback isolation, cross-process owner concurrency and original source integrity. |
| Actual owner stdio process | SDK client launched the real entry, listed five tools and read all 43,716 knowledge bytes with text equality against the file. No model call was required. |
| Independent agent review | Final authorization/persistence/model-policy implementation reviewed; no unresolved concrete findings. Initial concurrency and error-category findings were fixed and rechecked. |
| Agnes transport smoke | Two synthetic calls to the documented official endpoint returned HTTP 401. Existing session credential was not accepted. Valid model connection and output quality remain unverified; no automatic retries. |
| Original knowledge preservation | The imported 30,291-byte game 3.3 body matches SHA-256 `1da5b778618c20c50f803193050b1aa7163bb9bddc99450f2ee88c226ed8ef67`. Historical whitespace is preserved intentionally. |
| Codex registration | Added `personal-chat-coach` as an owner stdio MCP with an absolute Node/entry path; configuration readback matched. This active conversation does not gain new tools retroactively. |
| External service and data cleaning | No public deployment, individual account system, cleaned dataset, cleaning pipeline, billing enforcement or model training has been delivered. Restricted HTTP and raw ingestion boundaries were tested locally. |

GitHub CI is the additional integration gate for this PR. It performs zero model calls and uses no API credentials. Release acceptance must name a fixed candidate and actual environment; this evidence cannot be reused as a claim of production safety or model improvement.
