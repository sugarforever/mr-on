import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  renderService,
  ServiceCommandError,
  serviceMarker,
  type ServiceOptions,
} from "./service-config.js";

type CommandResult = {
  status: number | null;
  error?: Error;
  signal?: string | null;
  stdout?: string;
};
export interface ServiceRuntime {
  home?: string;
  root?: string;
  node?: string;
  platform?: string;
  uid?: number;
  defaultData?: string;
  run?: (argv: string[], capture?: boolean) => CommandResult;
  fetch?: (
    url: string,
    options: { signal: AbortSignal },
  ) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>;
  output?: (text: string) => void;
  readinessTimeoutMs?: number;
}

// Also accepts definitions produced before packaged releases. Never infer their
// data or port from the current cwd/environment.
function installedOptions(
  content: string,
): Pick<ServiceOptions, "data" | "port"> {
  const xml = (s: string) =>
    s
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  let data: string | undefined;
  let port: string | undefined;
  if (content.includes("<plist")) {
    data = content.match(
      /<key>MR_ON_DATA<\/key><string>([^<]*)<\/string>/,
    )?.[1];
    if (data) data = xml(data);
    port = content.match(/<key>PORT<\/key><string>(\d+)<\/string>/)?.[1];
  } else {
    data = content.match(/^Environment="MR_ON_DATA=(.*)"$/m)?.[1];
    if (data) data = data.replace(/\\([\\"])/g, "$1").replaceAll("%%", "%");
    port = content.match(/^Environment="PORT=(\d+)"$/m)?.[1];
  }
  if (!data || !port)
    throw new ServiceCommandError(
      "无法读取已安装服务的数据目录和端口；请检查服务定义。",
    );
  return { data, port: Number(port) };
}

export async function main(
  input = process.argv.slice(2),
  runtime: ServiceRuntime = {},
) {
  const args = [...input];
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
    throw new ServiceCommandError(
      "用法：mr-on service install|uninstall|start|stop|restart|status|logs [--dry-run] [--data PATH] [--port N]",
    );
  let dryRun = false;
  let platform = runtime.platform ?? process.platform;
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
      throw new ServiceCommandError("无效参数");
    const value = args.shift()!;
    if (flag === "--data") {
      data = value;
    }
    if (flag === "--port") {
      port = Number(value);
    }
    if (flag === "--platform") {
      platform = value;
      platformOverride = true;
    }
  }
  if (platformOverride && !dryRun)
    throw new ServiceCommandError("--platform 仅用于 --dry-run 预览");
  const location = dirname(fileURLToPath(import.meta.url));
  const root =
    runtime.root ??
    resolve(location, location.endsWith("/dist/src") ? "../.." : "..");
  const home = runtime.home ?? homedir();
  const uid = runtime.uid ?? process.getuid?.() ?? 0;
  const output = runtime.output ?? console.log;
  // Find the fixed user service path without validating the current package as
  // an install target: an npx CLI can still stop/uninstall an existing service.
  const identity = {
    node: "/node",
    root: "/package",
    data: "/data",
    port: 4317,
    home,
    uid,
  };
  let definition = renderService(platform, identity);
  const present = existsSync(definition.path);
  let installed: Pick<ServiceOptions, "data" | "port"> | undefined;
  if (present) {
    const stat = lstatSync(definition.path);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      !readFileSync(definition.path, "utf8").includes(serviceMarker)
    )
      throw new ServiceCommandError(
        "没有可安全管理的 mr-on 服务定义（所有者或标记不匹配）。",
      );
    if (action !== "install" && action !== "uninstall")
      installed = installedOptions(readFileSync(definition.path, "utf8"));
  }
  if (action === "install") {
    const actualRoot = existsSync(root) ? realpathSync(root) : root;
    const node = runtime.node ?? realpathSync(process.execPath);
    definition = renderService(platform, {
      node,
      root: actualRoot,
      data: resolve(data || runtime.defaultData || resolve(root, ".data")),
      port,
      home,
      uid,
    });
    if (present)
      throw new ServiceCommandError(
        "服务定义已存在；不会覆盖。更改路径请先 stop、uninstall，再 install。",
      );
  } else {
    if (installed)
      definition = renderService(platform, {
        ...identity,
        data: installed.data,
        port: installed.port,
      });
    if (present) definition.content = readFileSync(definition.path, "utf8");
    if (!present) {
      if (["status", "stop", "uninstall"].includes(action!)) {
        output("mr-on 服务未安装。");
        return;
      }
      throw new ServiceCommandError(
        "mr-on 服务未安装；请先运行 mr-on service install。",
      );
    }
  }
  const command = definition.commands[action as (typeof actions)[number]];
  const commands = (
    Array.isArray(command[0]) ? command : [command]
  ) as string[][];
  if (dryRun) {
    output(JSON.stringify({ dryRun, action, definition, commands }, null, 2));
    return;
  }
  if (uid === 0)
    throw new ServiceCommandError(
      "请用运行 mr-on 的普通用户执行；不支持 sudo/root 安装",
    );
  const execute =
    runtime.run ??
    ((argv: string[], capture = false) =>
      spawnSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        stdio: capture ? "pipe" : "inherit",
        ...(capture ? { timeout: 1000 } : {}),
      }));
  const run = (argv: string[], allowed: number[] = []) => {
    const result = execute(argv);
    if (
      result.error ||
      (result.status !== 0 && !allowed.includes(result.status ?? -1))
    )
      throw new ServiceCommandError(
        `系统命令失败（${result.status ?? result.signal ?? "无法执行"}）；用 mr-on service status 和 mr-on service logs 检查服务。`,
      );
    return result.status;
  };
  if (action === "install") {
    if (!existsSync(resolve(root, "dist/src/server.js")))
      throw new ServiceCommandError(
        "缺少构建后的服务；全局安装请重新 npm install -g mr-on，源码安装请先 npm run build。",
      );
    mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 });
    mkdirSync(definition.logs, { recursive: true, mode: 0o700 });
    writeFileSync(definition.path, definition.content, {
      mode: 0o600,
      flag: "wx",
    });
    output(`服务定义已写入 ${definition.path}`);
    if (platform === "linux")
      output(
        "Linux 登出后运行或未登录启动需要管理员启用 linger；本命令不修改此设置。",
      );
  }
  // launchd bootstrap is not idempotent: check whether the label is loaded first.
  let alreadyStarted = false;
  if (platform === "darwin" && action === "start") {
    const probe = definition.commands.status as string[];
    alreadyStarted = run(probe, [3, 113]) === 0;
  }
  if (!alreadyStarted)
    for (const argv of commands) {
      const allowed =
        platform === "darwin" && argv[1] === "bootout"
          ? [3, 113]
          : action === "status"
            ? platform === "darwin"
              ? [3, 113]
              : [3]
            : [];
      run(argv, allowed);
    }
  if (action === "uninstall") {
    unlinkSync(definition.path);
    if (platform === "linux") run(["systemctl", "--user", "daemon-reload"]);
    output("服务定义已删除，应用数据保留。");
  }
  if (["install", "start", "restart"].includes(action!)) {
    const installedPort = installed?.port ?? port;
    const url = `http://127.0.0.1:${installedPort}/readyz`;
    const timeout = runtime.readinessTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeout;
    const request = runtime.fetch ?? fetch;
    while (Date.now() < deadline) {
      try {
        const response = await request(url, {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(1000, deadline - Date.now())),
          ),
        });
        if (response.ok) {
          const health = (await response.json?.()) as
            { ready?: boolean; pid?: number } | undefined;
          const probe =
            platform === "darwin"
              ? (definition.commands.status as string[])
              : [
                  "systemctl",
                  "--user",
                  "show",
                  "--property=MainPID",
                  "--value",
                  "mr-on-gateway.service",
                ];
          const result = execute(probe, true);
          const managedPid =
            platform === "darwin"
              ? Number(result.stdout?.match(/^\s*pid = (\d+)$/m)?.[1])
              : Number(result.stdout?.trim());
          if (
            !result.error &&
            result.status === 0 &&
            Number.isInteger(managedPid) &&
            managedPid > 0 &&
            health?.ready === true &&
            health.pid === managedPid
          ) {
            output(`服务已就绪：${url}`);
            return;
          }
        }
      } catch {
        /* Startup may still be opening the database and listener. */
      }
      await new Promise((done) =>
        setTimeout(done, Math.min(250, Math.max(0, deadline - Date.now()))),
      );
    }
    throw new ServiceCommandError(
      `服务尚未就绪：${url}；请运行 mr-on service status 和 mr-on service logs 排查端口、数据锁或启动失败。定义与数据已保留。`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "服务命令失败");
    process.exitCode = 1;
  });
}
