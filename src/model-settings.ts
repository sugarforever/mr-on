import { completeSimple } from "@earendil-works/pi-ai/compat";
export type ModelSettings = {
  mode: "demo" | "live";
  baseUrl: string;
  model: string;
  apiKey: string;
};
export function validateModelSettings(
  c: Record<string, unknown>,
  old: ModelSettings,
): ModelSettings {
  const mode = c.mode === "live" ? "live" : "demo";
  const baseUrl = String(c.baseUrl || old.baseUrl);
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw Error("Model endpoint must be an HTTPS URL without credentials");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search)
    throw Error(
      "Model endpoint must be an HTTPS URL without credentials or query",
    );
  const model = String(c.model ?? old.model).trim();
  if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model))
    throw Error("Model must contain 1–200 printable characters");
  const apiKey =
    c.apiKey === undefined || c.apiKey === "" ? old.apiKey : String(c.apiKey);
  if (mode === "live" && !apiKey) throw Error("Please configure an API key");
  return { mode, baseUrl, model, apiKey };
}
export async function testModelConnection(
  config: ModelSettings,
  fixtureFetch?: typeof fetch,
) {
  if (config.mode === "demo") return;
  try {
    const response = await completeSimple(
      {
        id: config.model,
        name: config.model,
        api: "openai-completions",
        provider: "mr-on-live",
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 2048,
        compat: { supportsStore: false, supportsDeveloperRole: false },
      },
      {
        messages: [
          { role: "user", content: "Reply OK.", timestamp: Date.now() },
        ],
      },
      {
        apiKey: config.apiKey,
        fetch: fixtureFetch,
        maxTokens: 8,
        signal: AbortSignal.timeout(15000),
        maxRetries: 0,
        timeoutMs: 15000,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted")
      throw Error();
  } catch {
    throw Error("连接测试失败；请检查端点、模型、密钥和网络。设置未保存。");
  }
}
