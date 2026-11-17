import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderService, serviceMarker } from "./service-config.js";

function main() {
  const args = process.argv.slice(2);
  const action = args.shift();
  const actions = [
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "status",
    "logs",
  ] as const;
  if (!actions.includes(action as any))
    throw Error(
      "用法：npm run service -- install|uninstall|start|stop|restart|status|logs [--dry-run] [--data PATH] [--port N]",
    );
  let dryRun = false;
  let platform: string = process.platform;
  let data = process.env.MR_ON_DATA;
  let port = Number(process.env.PORT || 4317);
  let platformOverride = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      !["--data", "--port", "--platform"].includes(flag || "") ||
      !args.length
    )
      throw Error("无效参数");
    const value = args.shift()!;
    if (flag === "--data") data = value;
    if (flag === "--port") port = Number(value);
    if (flag === "--platform") {
      platform = value;
      platformOverride = true;
    }
  }
  if (platformOverride && !dryRun)
    throw Error("--platform 仅用于 --dry-run 预览");
  const location = dirname(fileURLToPath(import.meta.url));
  const root = resolve(
    location,
    location.endsWith("/dist/src") ? "../.." : "..",
  );
  const definition = renderService(platform, {
    node: process.execPath,
    root,
    data: resolve(data || resolve(root, ".data")),
    port,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
  });
  const command = definition.commands[action as (typeof actions)[number]];
  const commands: string[][] = Array.isArray(command[0])
    ? (command as string[][])
    : [command as string[]];
  if (dryRun) {
    console.log(
      JSON.stringify({ dryRun, action, definition, commands }, null, 2),
    );
    return;
  }
  if (process.getuid?.() === 0)
    throw Error("请用运行 mr-on 的普通用户执行；不支持 sudo/root 安装");
  const run = (argv: string[]) => {
    const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
    if (result.error) throw result.error;
    // launchctl bootout returns ESRCH (3) when a label is already unloaded.
    if (argv[0] === "launchctl" && argv[1] === "bootout" && result.status === 3)
      return;
    if (result.status !== 0)
      throw Error(
        `系统命令失败（${result.status ?? result.signal}）；用 service status 检查服务状态。`,
      );
  };
  if (action === "install") {
    if (!existsSync(resolve(root, "dist/src/server.js")))
      throw Error("请先运行 npm run build");
    if (existsSync(definition.path))
      throw Error(
        "服务定义已存在；不会覆盖。升级通常只需 build 后 restart，更改路径请先 uninstall。",
      );
    mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 });
    mkdirSync(definition.logs, { recursive: true, mode: 0o700 });
    writeFileSync(definition.path, definition.content, {
      mode: 0o600,
      flag: "wx",
    });
    console.log(`服务定义已写入 ${definition.path}`);
    if (platform === "linux")
      console.log(
        "Linux 用户服务：退出登录后运行或开机未登录启动需要管理员启用 linger；本命令不修改此设置。",
      );
  } else if (action === "uninstall") {
    if (
      !existsSync(definition.path) ||
      !readFileSync(definition.path, "utf8").includes(serviceMarker)
    )
      throw Error("没有可安全移除的 mr-on 服务定义");
  }
  for (const argv of commands) run(argv);
  if (action === "uninstall") {
    unlinkSync(definition.path);
    if (platform === "linux") run(["systemctl", "--user", "daemon-reload"]);
    console.log("服务定义已删除，应用数据保留。");
  }
}
try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "服务命令失败");
  process.exitCode = 1;
}
