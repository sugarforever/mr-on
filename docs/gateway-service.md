# Gateway background service

The mr-on Gateway is the existing Node/Express service. It listens for local API calls, receives webhooks, schedules SQLite plans, and invokes models through Pi when needed. The browser is not the scheduler; closing it does not stop background work. Idle operation makes no continuous model calls.

## Installation and management

After a global install, run these commands from any directory:

```bash
npm install -g @verysmallwoods/mron
mron service install --dry-run
mron service install
mron service status
mron service logs
```

A dry run prints configuration paths, contents, and native commands without creating directories, installing, or starting a service. Installation writes the user-service definition and starts it, then checks local `/readyz` for up to 30 seconds. It compares the response PID with the system service manager's process so another service on the same port is not mistaken for a successful startup. start/restart also wait for readiness; probes make no model calls. A timeout or failed system command exits nonzero, retaining definitions and data. Diagnose with status/logs rather than reinstalling over the error. --dry-run performs no readiness probes.

Only ordinary users are supported; commands use no sudo, do not overwrite existing definitions, and do not manage definitions missing the mr-on marker, owned by another user, or stored as symlinks. The application and Node use absolute paths captured at installation. Keep the package directory and that Node installation in place while running. After changing Node paths with nvm or similar tools, stop and uninstall the definition, then reinstall using the new Node. The temporary `npx` cache cannot be a service dependency: install globally before `mron service install`. An npx foreground trial does not install a background service.

Packaged data-directory precedence is explicit `--data`, then `MR_ON_DATA`, then `~/.mr-on`, independent of package location or working directory. Source development can still use `npm ci`, `npm run build`, and `npm run service -- install`, with the repository `.data` default. To retain an existing database, explicitly provide its original absolute path:

```bash
mron service install --data /absolute/path/to/mr-on/.data --port 4317 --dry-run
```

Data is not automatically moved and existing databases are not switched. Relative `--data` paths resolve against the calling directory and become fixed absolute paths for background execution. Later control commands read data/log paths and port from the installed definition, ignoring current --data/--port, environment defaults, and working directory. To change configuration, uninstall and reinstall the definition. Only one installed mr-on Gateway per user is supported.

Other management commands:

```bash
mron service stop
mron service start
mron service restart
mron service uninstall
```

`stop` stops the managed service without KeepAlive/Restart immediately bringing it back; `start` resumes it. On macOS, `restart` gracefully stops with bootout and starts with bootstrap rather than forceful kickstart. `uninstall` stops and deletes the definition while retaining data. Failed native commands exit nonzero and retain the definition for diagnosis; repeated installation is not a repair strategy. `status` shows system service manager state and can be queried repeatedly even when stopped or absent. stop/uninstall make no changes when absent. macOS start avoids another bootstrap when already loaded. Use the probes below to check application readiness.

Stop any foreground terminal service before installation to avoid port or data-lock conflicts. Different data directories still cannot share a port. Use `npm run dev` for development; background services run built `dist` output without automatic source reload.

## Platform boundaries

| Platform | Management                                      | Automatic startup and limitations                                                                                  |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| macOS    | `~/Library/LaunchAgents/ai.mr-on.gateway.plist` | Starts at user login and survives terminal closure; stops at logout. It is not a pre-login system daemon           |
| Linux    | `~/.config/systemd/user/mr-on-gateway.service`  | systemd user service; remaining active after logout or starting before login requires administrator-enabled linger |

On Linux, inspect linger with `loginctl show-user "$USER" -p Linger`. An administrator decides whether to run `sudo loginctl enable-linger USERNAME`; installation never enables it automatically. Minimal containers without user systemd/DBus do not support this installation method.

macOS configures RunAtLoad, KeepAlive, and a 10-second startup throttle. Linux uses Restart=always, a five-second restart interval, and at most ten starts in five minutes. After hitting the Linux limit, fix the cause, run `systemctl --user reset-failed mr-on-gateway.service` as the user or administrator, and start again.

Neither method guarantees task execution or network-event receipt while the host sleeps, is powered off, or lacks a network connection. For operation independent of a laptop, deploy the same Gateway on an always-online Linux host. System-level LaunchDaemons and systemd services are not installed.

## Health, status, and logs

```bash
curl --fail http://127.0.0.1:4317/healthz
curl --fail http://127.0.0.1:4317/readyz
```

`healthz` establishes HTTP responsiveness. `readyz` requires a queryable database, at least one completed scheduler tick, a heartbeat less than five seconds old, and no shutdown in progress; otherwise it returns 503. Unreachable models or websites cause task failures but do not alone fail process health checks. Probes make no model calls. Use the installed port.

The sidebar shows the latest scheduler heartbeat and research queue length. Hovering over service status shows startup, most recent completion, most recent successful check, and most recent failure times. Execution times come from persistent runs; research concurrency remains at most two, while profiles use their existing separate queue. A disconnected page shows “Status unknown” and its last connection time rather than claiming the server has stopped.

stdout/stderr contain timestamped JSON lifecycle logs for startup, shutdown, listen failures, scheduling errors, and shutdown timeouts, without model keys or request bodies. Task results and errors remain in SQLite and the run-history page.

Linux logs use the journal and its retention policy. macOS writes `logs/gateway.log` and `logs/gateway.error.log` under the data directory, without automatic rotation in this version. Before long unattended use, configure system log rotation or periodically stop and archive logs to limit disk growth. Data-directory permissions are 0700, service definitions 0600, and process umask 0077.

## Recovery, shutdown, and upgrades

- Acknowledged event receipt and enqueueing still commit in one SQLite transaction; redelivery of eventId does not enqueue again. Events not delivered locally have no local persistent record.
- queued work continues after restart; running work becomes interrupted and requires manual retry. Pi history is not an exact tool checkpoint; retries may call the model again.
- Multiple missed intervals coalesce into one catch-up check of the source's current body. Intermediate versions during downtime cannot be reconstructed. One-shot schedules retain existing pause/enqueue rules.
- Network and model reads retain bounded retries; no unlimited automatic replay is added. Restart does not automatically retry every failed task.
- Shutdown rejects new writes, stops claiming work, closes SSE, waits for HTTP requests and current execution, then closes SQLite and releases the process lock. The process terminates if still active after 100 seconds; the outer service manager allows 120 seconds. Next startup applies interrupted recovery.

Global package upgrade sequence (choose the pinned version yourself):

```bash
mron service stop
mron service status
# After confirming shutdown, back up the entire data directory to a protected location
npm install -g @verysmallwoods/mron@VERSION
mron service start
# start waits for readiness; then inspect run history and readyz on the installed port
```

Upgrading under the same npm global prefix and Node path preserves the service's absolute targets and data. For source installs, replace the global npm upgrade step with `npm ci && npm run build`. Do not overwrite a running package or dist directory, or run old and new services simultaneously. No automatic updater is provided. If changing the global prefix, package location, or Node installation, first stop and uninstall the definition, then reinstall after upgrading using the new Node and original absolute --data/--port. Uninstalling the definition retains data.

Back up the entire directory only after stopping the service, including SQLite/WAL, Pi sessions, and the webhook token. API keys remain in SQLite without application-layer encryption; protect backups equally. Pi sessions currently reference absolute paths. Direct restoration to a different data path is unsupported at this stage; retain the original absolute path. Uninstallation does not delete data.

## Manual acceptance

Automated tests do not install launchd/systemd services on the development machine. In the selected deployment environment, manually verify installation followed by terminal closure, automatic restart after killing the process, automatic startup after login or host restart, stopped services remaining stopped, log permissions/retention, and coalesced catch-up after sleep. On Linux without linger, do not claim pre-login startup acceptance.

References: [Apple launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [loginctl linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html).
