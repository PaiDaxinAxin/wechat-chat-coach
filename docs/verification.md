# Initial verification — 2026-09-30

This record describes development evidence, not a deployed service or verified chat effectiveness.

| Check | Result and scope |
| --- | --- |
| `npm test` on Node.js 26 | 45/45 passed; deterministic/mock contracts, actual MCP SDK connections, access boundaries, failures, raw feedback isolation, cross-process owner concurrency and original source integrity. |
| Actual owner stdio process | SDK client launched the real entry, listed five tools and read all 43,716 knowledge bytes with text equality against the file. No model call was required. |
| Actual owner coaching call | A client launched the configured owner stdio entry and called coach_reply with the synthetic conversation. Server-side Agnes completed validated native output in 5.3 seconds. This verifies the private configuration and MCP-to-provider integration. |
| Independent agent review | Final authorization/persistence/model-policy implementation reviewed; no unresolved concrete findings. Concurrency and error-category findings were fixed and rechecked. |
| Initial Agnes transport | Requests to the documentation default endpoint returned HTTP 401. These failures remain recorded; the owner subsequently specified a different gateway. |
| Owner-selected gateway | https://apihub.agnes-ai.com/v1 authenticated. An initial synthetic reply passed in 2.5 seconds; plain-text classification returned invalid output once and timed out once. After switching to a single forced function with mechanically derived schemas, classification passed in 11.0 seconds and reply passed in 9.3 seconds. Both used the same complete 43,716-byte knowledge. Model readback: agnes-3.0-flash; classification tokens 12,176 input / 506 output, reply 11,250 input / 146 output. No accuracy or chat-effectiveness claim. |
| Original knowledge preservation | The imported 30,291-byte game 3.3 body matches SHA-256 `1da5b778618c20c50f803193050b1aa7163bb9bddc99450f2ee88c226ed8ef67`. Historical whitespace is preserved intentionally. |
| Codex registration | Added `personal-chat-coach` as an owner stdio MCP with an absolute Node/entry path and a private environment file outside the repository; configuration readback matched. Secrets have mode 0600 and are not committed. This active conversation does not gain new tools retroactively. |
| External service and data cleaning | No public deployment, individual account system, cleaned dataset, cleaning pipeline, billing enforcement or model training has been delivered. Restricted HTTP and raw ingestion boundaries were tested locally. |

GitHub CI is the additional integration gate for this PR. It performs zero model calls and uses no API credentials. Release acceptance must name a fixed candidate and actual environment; this evidence cannot be reused as a claim of production safety or model improvement.
