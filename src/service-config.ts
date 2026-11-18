import { isAbsolute, join } from "node:path";
export interface ServiceOptions {
  node: string;
  root: string;
  data: string;
  port: number;
  home: string;
  uid: number;
}
const label = "ai.mr-on.gateway";
export const serviceMarker = "Managed by mr-on gateway service";
export function renderService(platform: string, o: ServiceOptions) {
  if (!["darwin", "linux"].includes(platform))
    throw Error("仅支持 macOS 和 Linux");
  for (const path of [o.node, o.root, o.data, o.home])
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path))
      throw Error("服务路径必须是无控制字符的绝对路径");
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)
    throw Error("端口需为 1–65535");
  if (!Number.isInteger(o.uid) || o.uid < 0) throw Error("无效用户 ID");
  if ([o.node, o.root].some((path) => /(?:^|[\\/])_npx(?:[\\/]|$)/.test(path)))
    throw Error(
      "npx 缓存不能作为后台服务路径；请先 npm install -g mr-on，再运行 mr-on service install。",
    );
  const script = join(o.root, "dist/src/server.js");
  const logs = join(o.data, "logs");
  if (platform === "darwin") {
    const xml = (s: string) =>
      s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
    const path = join(o.home, "Library/LaunchAgents", `${label}.plist`);
    const domain = `gui/${o.uid}`;
    const target = `${domain}/${label}`;
    return {
      path,
      logs,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${serviceMarker} -->
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(o.node)}</string><string>${xml(script)}</string></array>
<key>WorkingDirectory</key><string>${xml(o.root)}</string>
<key>EnvironmentVariables</key><dict><key>MR_ON_DATA</key><string>${xml(o.data)}</string><key>PORT</key><string>${o.port}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>120</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "gateway.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "gateway.error.log"))}</string>
</dict></plist>\n`,
      commands: {
        install: [
          ["launchctl", "enable", target],
          ["launchctl", "bootstrap", domain, path],
        ],
        start: ["launchctl", "bootstrap", domain, path],
        stop: ["launchctl", "bootout", target],
        restart: [
          ["launchctl", "bootout", target],
          ["launchctl", "bootstrap", domain, path],
        ],
        status: ["launchctl", "print", target],
        uninstall: [["launchctl", "bootout", target]],
        logs: [
          "tail",
          "-n",
          "100",
          "-F",
          join(logs, "gateway.log"),
          join(logs, "gateway.error.log"),
        ],
      },
    };
  }
  // systemd expands % specifiers everywhere and $ variables in ExecStart.
  const quote = (s: string, exec = false) =>
    '"' +
    s
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", exec ? "$$" : "$") +
    '"';
  const unit = "mr-on-gateway.service";
  return {
    path: join(o.home, ".config/systemd/user", unit),
    logs,
    content: `# ${serviceMarker}
[Unit]
Description=mr-on Gateway
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${quote(o.root)}
ExecStart=${quote(o.node, true)} ${quote(script, true)}
Environment=${quote(`MR_ON_DATA=${o.data}`)}
Environment="PORT=${o.port}"
UMask=0077
Restart=always
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`,
    commands: {
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", unit],
      ],
      start: ["systemctl", "--user", "start", unit],
      stop: ["systemctl", "--user", "stop", unit],
      restart: ["systemctl", "--user", "restart", unit],
      status: ["systemctl", "--user", "status", "--no-pager", unit],
      uninstall: [["systemctl", "--user", "disable", "--now", unit]],
      logs: ["journalctl", "--user", "-u", unit, "-n", "100", "-f"],
    },
  };
}
