import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import { openConfiguration } from "./configuration.js";
import { validateModelSettings } from "./model-settings.js";
export interface PromptIO {
  ask(text: string, options?: { secret?: boolean }): Promise<string | null>;
  write(text: string): void;
}
export function terminalIO(
  input = process.stdin,
  output = process.stdout,
): PromptIO {
  return {
    write(text) {
      output.write(text + "\n");
    },
    async ask(text, options) {
      if (!input.isTTY || !output.isTTY)
        throw Error("请在交互式终端运行 mr-on onboard 或 mr-on configure。");
      output.write(text + " ");
      emitKeypressEvents(input);
      const raw = input.isRaw;
      input.setRawMode(true);
      input.resume();
      return await new Promise<string | null>((resolve) => {
        let value = "";
        const finish = (answer: string | null) => {
          input.off("keypress", key);
          input.off("end", end);
          input.setRawMode(raw);
          input.pause();
          output.write("\n");
          resolve(answer);
        };
        const end = () => finish(null);
        const key = (
          text: string,
          k: { name?: string; ctrl?: boolean; meta?: boolean },
        ) => {
          if (k.ctrl && ["c", "d"].includes(k.name || "")) return finish(null);
          if (k.name === "return") return finish(value);
          if (k.name === "backspace") {
            if (value) {
              value = Array.from(value).slice(0, -1).join("");
              if (!options?.secret) output.write("\b \b");
            }
            return;
          }
          if (text && !k.ctrl && !k.meta && !/[\x00-\x1f\x7f]/.test(text)) {
            value += text;
            if (!options?.secret) output.write(text);
          }
        };
        input.on("keypress", key);
        input.once("end", end);
      });
    },
  };
}
const cancelled = Symbol("cancelled");
export async function runOnboarding(
  command: "onboard" | "configure",
  dir: string,
  dependencies: {
    io?: PromptIO;
    install?: () => Promise<unknown>;
    open?: (url: string) => Promise<unknown>;
    test?: (config: Record<string, unknown>) => Promise<void>;
  } = {},
) {
  const io = dependencies.io || terminalIO();
  const ask = async (text: string, secret = false) => {
    const a = await io.ask(text, { secret });
    if (a === null) throw cancelled;
    return a.trim();
  };
  const yes = async (text: string) =>
    (await ask(text + " [y/N]")).toLowerCase() === "y";
  let saved = false;
  let config: Awaited<ReturnType<typeof openConfiguration>> | undefined;
  try {
    // Check interactivity before opening or creating any data.
    const modeInput = await ask(
      "模型模式：demo 离线演示 / live 在线模型（留空保留现有设置）",
    );
    config = await openConfiguration(dir);
    const current = config.current;
    const mode = modeInput || current.mode;
    if (!["demo", "live"].includes(mode)) throw Error("请输入 demo 或 live。");
    const draft: Record<string, unknown> = { mode };
    if (mode === "live") {
      draft.baseUrl =
        (await ask(`HTTPS 端点 [${current.baseUrl}]`)) || current.baseUrl;
      draft.model = (await ask(`模型 [${current.model}]`)) || current.model;
      draft.apiKey = await ask(
        current.hasKey
          ? "API 密钥（输入隐藏；留空保留）"
          : "API 密钥（输入隐藏）",
        true,
      );
    }
    validateModelSettings(draft, {
      ...current,
      apiKey: current.hasKey ? "retained-key-placeholder" : "",
    });
    if (
      mode === "live" &&
      (await yes(
        "测试连接？仅发送固定的 Reply OK，无工具或用户数据，可能产生模型费用；15 秒超时。",
      ))
    ) {
      try {
        await (dependencies.test || config.test)(draft);
        io.write("连接测试通过。");
      } catch {
        io.write(
          "连接测试失败；未保存设置，也未安装服务。请运行 mr-on configure 重试。",
        );
        return;
      }
    }
    if (!(await yes("保存模型设置？密钥以未加密形式保存在本机 SQLite 中。")))
      throw cancelled;
    await config.save(draft);
    saved = true;
    config.close();
    config = undefined;
    io.write("模型设置已保存；后续运行使用新设置，正在运行的任务保留其配置。");
    if (command === "configure") return;
    if (await yes("安装并启动当前用户的后台服务？")) {
      try {
        if (dependencies.install) await dependencies.install();
        else {
          const service = (await import("./service.js")) as unknown as {
            main: (args: string[]) => Promise<void>;
          };
          await service.main(["install", "--data", dir]);
        }
      } catch {
        io.write(
          "设置已保存，但服务未确认就绪。请运行 mr-on service install --data " +
            JSON.stringify(dir) +
            "，再检查 mr-on service status。",
        );
        return;
      }
      if (await yes("打开本地工作台？")) {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        let url = "http://127.0.0.1:4317";
        try {
          url = JSON.parse(
            readFileSync(join(dir, "gateway.json"), "utf8"),
          ).origin;
        } catch {}
        if (dependencies.open) await dependencies.open(url);
        else await openBrowser(url);
      }
    } else
      io.write(
        "需要时运行 mr-on start --data " +
          JSON.stringify(dir) +
          "，或 mr-on service install --data " +
          JSON.stringify(dir) +
          "。",
      );
  } catch (e) {
    if (e === cancelled)
      io.write(
        saved
          ? "已取消后续步骤；设置已保存。需要时运行 mr-on service install。"
          : "已取消；原有设置和服务保持不变。",
      );
    else throw e;
  } finally {
    config?.close();
  }
}
async function openBrowser(url: string) {
  const u = new URL(url);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    u.username ||
    u.password
  )
    throw Error("工作台地址无效");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "darwin" ? "open" : "xdg-open",
      [u.href],
      { stdio: "ignore" },
    );
    child.once("error", () =>
      reject(Error("无法打开浏览器；请手动打开本地工作台。")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(Error("无法打开浏览器；请手动打开本地工作台。")),
    );
  });
}
