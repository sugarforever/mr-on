import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
export function assertPublicAddress(address: string) {
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  if (parsed.range() !== "unicast")
    throw Error("禁止访问本机、私有或特殊网络地址");
}
export async function readPublicUrl(
  value: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let current = new URL(value);
  for (let redirects = 0; redirects < 5; redirects++) {
    if (
      !["http:", "https:"].includes(current.protocol) ||
      current.username ||
      current.password ||
      !["", "80", "443"].includes(current.port)
    )
      throw Error("仅支持公开 HTTP(S) 标准端口");
    const hostname = current.hostname.replace(/^\[|\]$/g, "");
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        if (combined.aborted) return reject(Error("读取超时"));
        combined.addEventListener("abort", () => reject(Error("读取超时")), {
          once: true,
        });
      }),
    ]);
    if (!addresses.length) throw Error("域名无地址");
    for (const a of addresses) assertPublicAddress(a.address);
    const pinned = addresses[0];
    const result = await new Promise<{ location?: string; text?: string }>(
      (resolve, reject) => {
        const req = (
          current.protocol === "https:" ? httpsRequest : httpRequest
        )(
          current,
          {
            method: "GET",
            family: pinned.family,
            signal: combined,
            headers: {
              "User-Agent": "mr-on/0.1 public-document-monitor",
              Accept: "text/html,text/plain",
              "Accept-Encoding": "identity",
            },
            lookup: (_host, _opts, cb) =>
              cb(null, pinned.address, pinned.family),
          },
          (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
              res.destroy();
              if (!res.headers.location) return reject(Error("无效跳转"));
              return resolve({ location: res.headers.location });
            }
            if ((res.statusCode || 500) >= 400) {
              res.resume();
              return reject(Error(`资料返回 HTTP ${res.statusCode}`));
            }
            const type = res.headers["content-type"] || "";
            if (!/^(text\/(plain|html)|application\/xhtml\+xml)/i.test(type)) {
              res.resume();
              return reject(Error("仅支持文本和 HTML 资料"));
            }
            if (
              res.headers["content-encoding"] &&
              res.headers["content-encoding"] !== "identity"
            ) {
              res.destroy();
              return reject(Error("不支持压缩响应"));
            }
            const parts: Buffer[] = [];
            let size = 0;
            res.on("data", (b: Buffer) => {
              size += b.length;
              if (size > 512000) {
                res.destroy();
                reject(Error("资料超过 500 KB 限制"));
              } else parts.push(b);
            });
            res.on("error", reject);
            res.on("end", () => {
              let text = Buffer.concat(parts).toString("utf8");
              if (type.includes("html")) {
                const $ = load(text);
                $("script,style,noscript,nav,footer,header,svg").remove();
                text = $("body").text();
              }
              text = text.replace(/\s+/g, " ").trim();
              if (text.length > 60000)
                return reject(Error("正文超过 60,000 字符限制"));
              if (!text) return reject(Error("资料正文为空"));
              resolve({ text });
            });
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    if (result.text !== undefined) return result.text;
    current = new URL(result.location!, current);
  }
  throw Error("跳转次数过多");
}
