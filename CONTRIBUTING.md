# Contributing

Code and the complete knowledge are open for community collaboration. Code contributions use MIT; knowledge and framework contributions use CC BY 4.0 as specified in [LICENSING.md](LICENSING.md). Submit only material you have authority to contribute under the applicable license. External dependencies retain their own notices.

Useful contributions include small reproducible bug fixes, provider compatibility, accessibility, clearer terminology, counterexamples, and evidence-backed improvements to the knowledge or evaluations. No payment, donation or private-data contribution to this project is required to use its source, self-host it, or contribute. The official hosted service is planned as a separate paid offering using our AI provider; self-hosters manage their own models, infrastructure and data.

## Propose a change

1. Describe the concrete problem, expected behavior and the conditions where it occurs.
2. For code, keep one focused change and explain how to reproduce and verify it. Include the model/provider capability involved when relevant, but never its API key or account credentials.
3. For knowledge, describe the proposed rule, its source, where it applies, its limits and plausible counterexamples. Keep observations separate from interpretation. A fictional example illustrates behavior; it does not establish real-world success.
4. Submit a pull request. Maintainers review correctness, compatibility, privacy and evidence before accepting it. This review policy governs the upstream project, not the reuse rights granted by the licenses.

## Owner review and deployment

Community contributors work in forks and submit PRs; open-source access does not grant write access to the upstream repository or any cloud account. **PaiDaxinAxin reviews community PRs before merge.** `.github/CODEOWNERS` assigns all paths, including CI and ownership changes, to the owner. Required checks must pass, review conversations must be resolved, and changed commits require renewed review. Do not merge a community PR merely because an AI review or CI is green.

Merging and deploying are separate decisions. The owner must authorize the exact reviewed revision before a production release. Contributors and automated agents must not push directly to production, use an admin bypass, connect an automatic production deployment, or promote an unreviewed preview. A fork author can deploy their own installation under the licenses; that grants no authority over the official service.

Public/fork PR CI uses synthetic data, read-only repository permissions and no real provider, database, mail or deployment secrets. The current check workflow does not deploy anything. Keep untrusted PR code out of privileged workflows; do not add `pull_request_target` execution of a contributor's code with secrets. The current hosted application is a protected owner preview and refuses production startup; a future production launch needs a reviewed account-access design and a separate owner-approved deployment path.

The upstream knowledge preserves the original game 3.3 bytes between its source markers for provenance. Propose revisions as clearly sourced supplements outside those markers. Do not silently replace the full knowledge with a summary. Explicit refusal, uncertain evidence, individual style and current scope must remain distinguishable from numerical heat or a recommended direction.

## Keep private material out of public contributions

Use fictional or otherwise safely publishable cases. Do not paste raw private chat exports, identifiable screenshots, contact details, exact private addresses, account credentials or someone else's profile into public issues or PRs. A user's permission to receive coaching does not by itself authorize publishing their counterpart's information.

Operational feedback is not automatically a public dataset or training material. The reviewed improvement plan is in [docs/model-access-and-learning.md](docs/model-access-and-learning.md); external contribution, withdrawal and release controls are still planned. Public source code does not grant access to the hosted owner's workspace or its administrative tools.

## Local verification

Use Node.js 26 and `npm ci --ignore-scripts`. Run `npm test` and `npm run build` for relevant code changes. Browser behavior checks are listed in [README.md](README.md). PostgreSQL integration suites need dedicated disposable databases; never point them at a personal or production database. CI uses synthetic fixtures and no paid model or email calls.

Use your own private provider configuration for deliberate live experiments, with a bounded call count. Never commit environment files, runtime data, screenshots containing personal details or provider response bodies. Give reviewers the actual validation scope; a mocked test does not prove live model compatibility or better real conversations.
