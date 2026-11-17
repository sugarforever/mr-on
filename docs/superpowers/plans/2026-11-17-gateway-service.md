# Gateway Service Implementation Plan

**Goal:** Run the existing mr-on Gateway under launchd or systemd with explicit service commands and truthful runtime status.

**Architecture:** Retain the single Node/Express process, SQLite scheduler and Pi SDK. A CLI generates native per-user service definitions and controls them; no system changes occur until the operator runs install. Health and UI status describe the Gateway independently from model activity.

**Tech Stack:** TypeScript, Node, launchd LaunchAgent, systemd user service.

**Spec:** User-approved Gateway/daemon approach in this chat.

## Constraints

- Loopback only; no public ingress, Docker, Redis, or additional execution engine.
- Reuse the current checkout on a feature branch; do not install services on the development machine.
- Fixed absolute executable, application and data paths; existing foreground data remains compatible.
- macOS starts at login; Linux user service requires linger for execution after logout. Neither provides execution during host shutdown or sleep.
- Retain queued/interrupted/manual-retry semantics and existing concurrency.

## Review Focus

- Paths with spaces and configuration injection must not alter service commands.
- Installing must not silently overwrite an existing service definition.
- A service process existing is insufficient evidence of a working scheduler.
- Closing requests and streams must finish before closing SQLite.
- Browser connection loss must not continue to display a healthy service.

## Tasks

- [x] Add tests for native service generation, dry-run side effects, invalid input, health readiness and process restart recovery; observe failures.
- [x] Implement a service CLI with install/uninstall/start/stop/restart/status/logs and dry-run. Use native argument arrays, owner-only config, no shell commands. Never auto-enable linger.
- [x] Add runtime identity, scheduler heartbeat, health/readiness, safe operational logs and bounded graceful stopping. Surface runtime status and connection loss in the UI.
- [x] Document install, data location, platform lifecycle, logs, recovery, backup/upgrade and limits.
- [x] Run build, full tests, demo, browser tests and format checks; review the diff. Report native service installation/reboot verification as an operator acceptance step, not a completed test.

## Verification results

Native service installation, logout/reboot and supervisor restart are operator acceptance checks; no real service was installed during development. Native macOS plist validation uses plutil; Linux configuration is covered by rendering and CLI dry-run tests.
