# Merge checks

CI runs for every PR and main update, without path filters. Documentation and skill changes also require checks.

| Check                     | Coverage                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Quality                   | Formatting for source, UI, tests, skills, documentation, and workflows; browser JavaScript syntax; diff whitespace errors |
| Tests (22.19.0 / 24 / 26) | TypeScript build, unit/integration tests, and offline demo on the minimum supported version and two later major versions  |
| Browser                   | Real UI flows and mobile layouts in Chromium; verifies tests do not modify tracked files                                  |
| Dependency audit          | Known high/critical vulnerabilities in all locked dependencies, including development dependencies                        |
| Merge gate                | Every group above must succeed; failures, skips, and cancellations do not pass                                            |

Tests use no real API keys and send no external notifications. Browser failures retain traces, screenshots, and HTML reports for seven days. CI screenshots go into test-results and do not overwrite product previews in the repository.

Actions are pinned to full commit SHAs. Workflow tokens have only contents:read, and checkout credentials are not persisted. PR code does not gain additional permissions through pull_request_target. Jobs have timeouts, and new commits cancel outdated runs for the same PR.

In the GitHub main branch rules, make “Merge gate” required and require branches to be up to date. This is a repository setting; committing a workflow does not enable branch protection. Humans still need to review requirements, tool permissions, sensitive information, and online-model behavior that offline fixtures cannot establish.

Locally, run npm run format:check, npm run check:browser, npm run build, npm test, npm run demo, and npm run test:ui in order. Run npm audit --audit-level=high for dependency auditing. The audit depends on current npm registry advisories; address findings or document a specific, time-limited exception rather than ignoring failures.
