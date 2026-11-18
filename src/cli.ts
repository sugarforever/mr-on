#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ServiceCommandError } from "./service-config.js";
import { resolveDataDir } from "./paths.js";

type Command = "start" | "service" | "client" | "onboard" | "configure";
export type CliHandler = (args: string[], data: string) => unknown;
export type CliHandlers = Partial<Record<Command, CliHandler>>;
const help = `用法：mr-on [start|service|client] [参数] [--data PATH]
  mr-on / mr-on start   前台运行（默认端口 4317，仅本机）
  service              install|uninstall|start|stop|restart|status|logs
  client               list|history|send|watch|credentials
  --data PATH          数据目录（优先于 MR_ON_DATA，默认 ~/.mr-on）
  --help / --version   显示帮助或版本，不启动服务
`;

/** Lazy handlers keep help/version free of database and gateway initialization. */
export async function runCli(args: string[], handlers: CliHandlers = {}) {
  const rest = [...args];
  let explicit: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--data") continue;
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) throw Error("--data 需要路径");
    explicit = value;
    rest.splice(i, 2);
    i--;
  }
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(help);
    return;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    console.log(pkg.version);
    return;
  }
  const command = (rest.shift() || "start") as Command;
  if (!["start", "service", "client", "onboard", "configure"].includes(command))
    throw Error("未知命令；运行 mr-on --help 查看用法");
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(help);
    return;
  }
  const data = resolveDataDir(explicit);
  if (handlers[command]) return await handlers[command]!(rest, data);
  if (command === "start") {
    if (rest.length) throw Error("start 不支持此参数；使用 PORT 设置端口");
    return (await import("./server.js")).start({ data });
  }
  if (command === "service") {
    return (await import("./service.js")).main([...rest, "--data", data]);
  }
  if (command === "client")
    return (await import("./client.js")).main(rest, data);
  throw Error("此版本尚未包含引导配置；请使用本地网页的模型设置");
}

export function cliErrorMessage(error: unknown): string {
  return error instanceof ServiceCommandError
    ? error.message
    : "命令失败；运行 mr-on --help 检查用法，或检查本地服务状态。";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    // Arguments and nested exceptions can contain credentials; never echo them.
    console.error(cliErrorMessage(error));
    process.exitCode = 1;
  });
}
