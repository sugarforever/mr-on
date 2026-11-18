# npm 安装与手动发布

需要 Node.js >=22.19.0。此文描述发布后的安装方式；本 PR 不发布 npm。
2026-11-18 查询公共 npm registry 时 `mr-on` 返回 E404，名称尚未预留。
发布前重新确认名称及账号权限；若名称不可用，改用维护者控制的 scope
（如 `@sugarforever/mr-on`，需先确认 scope 权限），同步 package.json、lockfile 和安装文案。

```sh
npm install -g mr-on
mr-on --help
mr-on start
# 固定版本安装 / 一次性前台试用
npm install -g mr-on@0.1.0
npx mr-on@latest
```

默认前台运行，仅监听本机，端口 4317。通过 `PORT` 环境变量修改端口。
`mr-on service --help`、`mr-on client --help` 查看命令；本阶段模型设置仍在网页中完成。
使用 `mr-on onboard` 完成模型配置并选择是否安装后台服务；`mr-on configure` 只修改模型设置。详见 [终端引导](onboarding.md) 与 [后台服务](gateway-service.md)。

所有打包命令的数据路径：`--data PATH` > `MR_ON_DATA` > `~/.mr-on`。
相对路径按启动时工作目录解析。不要把数据放在 npm 安装目录或 npx 缓存。
仓库现有 `npm run start`、`npm run client`、`npm run service` 保持原有 `.data` 行为。
旧用户应明确指定原目录，例如 `mr-on start --data /absolute/path/to/mr-on/.data`；
不会自动迁移或选择旧数据库。先停止原网关并备份数据，不要复制运行中的 SQLite 文件。
SQLite 中保存的模型凭据**未加密**；保留目录与文件权限，备份也应按敏感数据处理。

卸载前先停止并卸载已安装的用户服务，再执行 `npm uninstall -g mr-on`。
卸载 npm 包不删除 `~/.mr-on` 或显式选择的数据目录。
服务升级、绝对 Node 路径与重新安装注意事项见 [服务说明](gateway-service.md)。

## 维护者发布步骤

1. 合并顺序为 package → service → onboarding；功能完成、代码审核与 CI 通过后再准备发布。
2. 检查干净的发布提交、版本号、npm 账号/名称权限以及依赖许可证。
3. 执行 `npm ci`、`npm run build`、`npm test`、`npm run demo`、`npm run format:check`、
   `npm run check:browser`、`npm run test:ui`、`npm audit --audit-level=high`、`npm run test:package`。
4. `npm pack --json` 会先构建。检查文件清单只含 dist/src JavaScript、public、skills、元数据与必要说明，
   不得含数据库、令牌、密钥、测试、源码、开发依赖或本地配置。
5. 检查实际 tarball 的临时安装测试，核实版本、静态资源、技能和前台启动。
   本仓库 `test:package` 自动完成这些步骤，不安装真实服务。
6. 由有权限的维护者主动执行 `npm publish <已检查的 tarball> --access public`，完成交互认证。
   不在命令参数、日志或 PR 中放令牌。无自动发布工作流。
7. 发布后核对 registry 元数据并从无源码目录安装已发布版本，再建立对应版本标签/发布记录。

显式 files allowlist 不包含开发测试产物。运行时依赖仍由 npm 解析和安装，
不是零依赖二进制；Pi SDK 含多种提供商的传递依赖。依赖审计与许可证清单应在每次发布时重新检查。
本次 lockfile 中非开发依赖许可证字段：MIT 132、Apache-2.0 38、BlueOak-1.0.0 4、
BSD-3-Clause 14、ISC 11、BSD-2-Clause 10、Unlicense 1、0BSD 1，
无缺失字段；这是元数据核查，发布前仍需复核实际许可证与再分发义务。

当前打包验证不代表已验证真实模型兼容性，也不代表已完成真实 launchd/systemd 生命周期测试。
