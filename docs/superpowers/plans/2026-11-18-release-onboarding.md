# npm Release and Service Onboarding Implementation Plan

**Goal:** Install mr-on through npm, configure it through a guided terminal flow, and run it as a persistent per-user service with a local web workbench.

**Architecture:** One npm package supplies the CLI, compiled server, public assets and bundled skills. launchd/systemd manage the existing gateway. Terminal and browser configuration share the existing SQLite settings and validation, with authenticated local API writes while the gateway is running.

**Tech stack:** TypeScript, Node.js >=22.19.0, npm, Express, SQLite, Pi SDK, macOS launchd and Linux systemd user services.

## User experience and constraints

Recommended flow: `npm install -g mr-on`, then `mr-on onboard`. Onboarding offers offline demo or an OpenAI-compatible Chat Completions provider, gathers HTTPS endpoint/model/key, tests live credentials with explicit user initiation, saves settings, installs/starts the service, waits for readiness, and opens the local workbench. Users may skip service installation or browser opening. `mr-on configure` revisits model settings without reinstalling the service.

`mr-on` and `mr-on start` run in the foreground; `npx mr-on@latest` is a foreground trial. `mr-on service install|uninstall|start|stop|restart|status|logs` manages persistent operation. `--help` and `--version` must work without starting a server or creating data. Package name availability must be checked before promising the unscoped name; document a scoped fallback if occupied.

Keep port 4317 and loopback-only binding. Preserve Chinese-first product copy. No curl installer, Windows service, new provider protocols, public listener, automatic npm publication, or automatic PR merge in this scope. Never install a real host service during automated tests. Never expose API keys in arguments, logs, errors, dry-run output, or PR artifacts. Preserve existing file permissions and clearly document that SQLite credentials are not encrypted.

Packaged commands resolve data consistently: explicit `--data` wins over `MR_ON_DATA`, otherwise use `~/.mr-on`. Share the resolver across server, service, onboarding and client. Keep repository npm scripts compatible with their existing `.data` behavior; do not silently migrate or select another database. Document explicit use of the old absolute data path. Never store user data inside the npm package or npx cache.

Existing web model settings remain available and observe the same settings. Preserve the store's blank-key-means-keep behavior. Never write the database directly while a gateway owns the data lock: use the protected local API with origin/authentication requirements intact; if no gateway is running, use an exclusive configuration path that respects the same lock. A live run keeps its captured configuration; subsequent runs use saved changes.

## Session 1: npm package and unified CLI

Own `package.json`, lockfile, new CLI/path modules, packaging tests and release documentation. Refactor entry points only as needed for import-safe dispatch; coordinate changes to shared service/server/client entry points with the other sessions.

- [ ] Add tests for command dispatch, help/version without side effects, unknown commands and data-path precedence from unrelated working directories.
- [ ] Implement a shebang CLI with `start`, `service` and `client` routing, and exports allowing later `onboard`/`configure` integration without implementing those workflows here.
- [ ] Publish only required compiled code, public assets, skills and metadata through an explicit npm files allowlist; build before pack. Remove private status when metadata is ready. Check runtime transitive dependencies and licensing before claiming release readiness.
- [ ] Run `npm pack`, install the tarball in a temporary prefix, and smoke-test executable startup, web assets and skill resolution without a source checkout. Assert no data, keys, tests or development artifacts leak into the tarball.
- [ ] Document global install, foreground trial, version pinning, uninstall and a controlled manual publication procedure. Do not publish to npm.
- [ ] Run relevant tests, build, demo and format checks; open a PR with verified results and limitations.

## Session 2: packaged background-service lifecycle

Own `src/service.ts`, `src/service-config.ts`, service tests and `docs/gateway-service.md`. Depends on Session 1's CLI/path contract; develop independently, then integrate or stack with its branch before final verification.

- [ ] Test stable absolute Node/package/data paths, paths containing spaces, idempotent status/control operations, custom ports, unsupported platforms, existing definitions and manager-command failures.
- [ ] Export an import-safe service command callable by the CLI and onboarding. Preserve dry-run, ordinary-user-only installation, ownership checks, graceful shutdown and data-preserving uninstall.
- [ ] Ensure install starts the service and control commands consult installed configuration instead of guessing current cwd/default data or port. Reject npx-cache service targets with actionable global-install guidance.
- [ ] Verify readiness after startup with a bounded timeout and actionable errors. Preserve existing health/readiness semantics and avoid calling the model for readiness.
- [ ] Document stop/backup/npm upgrade/start/readiness sequence; explain absolute Node paths and reinstall after changing Node installations, login/linger limits, sleep and recovery, and logs. Do not invent an unsafe automatic updater.
- [ ] Use generated definitions and mocked process execution in tests; report real launchd/systemd lifecycle checks as manual unless actually exercised in a suitable disposable environment.
- [ ] Run required checks and open a PR referencing the dependency and the design.

## Session 3: guided onboarding and model configuration

Own new onboarding/configuration modules, shared model-settings validation/test helper, configuration API integration, terminal tests and onboarding documentation. Depends on Sessions 1 and 2; avoid duplicating their CLI/path/service implementation and stack or integrate their branches for final verification.

- [ ] Test offline demo, live provider values, hidden key entry, retained existing key, invalid URL/model, failed connection, cancellation, EOF/non-TTY behavior and rerunning onboarding without overwriting existing configuration.
- [ ] Build `mr-on onboard` and `mr-on configure` as guided terminal flows. Keep prompts testable through injected I/O. Do not require a full-screen TUI framework; a small prompt library or readline flow is sufficient.
- [ ] Reuse store validation and settings for web/terminal parity. Support stopped-gateway configuration under the data lock and running-gateway changes through its protected local API. Test concurrent configuration and preserve HTTP security protections.
- [ ] Offer an explicitly initiated bounded connection test using the same Pi provider/protocol as real work, with fixed minimal content, no tools or user data, no hidden retries, sanitized errors and clear potential model cost. Demo makes no network/model call. A failed test must not replace working settings or install the service silently.
- [ ] Onboard saves configuration, then offers service installation through Session 2's exported command, readiness and optional browser opening. Configure changes settings only. Cancellation leaves existing service/data intact; partial completion explains the exact next command.
- [ ] Add integration coverage for configure while running, settings becoming visible in the browser, and new runs using changed settings. Use local fixtures; document that real API compatibility is unverified unless tested with authorized credentials.
- [ ] Run required checks and open a PR linking dependencies and design.

## Review focus and delivery

Verify npx-cache paths cannot become service dependencies; upgrades retain data and service target; existing `.data` users receive explicit migration guidance; configuration respects process locks and HTTP protections; secrets stay out of all observable output. Each owner includes tests for these conditions in its scope.

Implementation chats must use separate git working directories/branches before editing because they share one project checkout. Each PR should remain independently reviewable; use stacked PRs for dependent integration and state merge order: package, service, onboarding. No session may merge or publish automatically.
