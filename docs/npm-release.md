# npm 安装与发布

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
`mr-on service --help`、`mr-on client --help` 查看命令。
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

## 自动发布流程

功能合并到 `main` 后，`.github/workflows/release.yml` 使用 release-please 创建或更新版本 PR，自动维护 package.json、package-lock.json、CHANGELOG 和版本 manifest。提交信息使用 Conventional Commits，例如 `feat: add a capability`、`fix: correct a failure`。0.x 阶段功能升 minor、修复升 patch。manifest 从现有 0.1.0 开始，bootstrap 提交之前的历史不会重复进入发布说明。

release-please 使用内置 GITHUB_TOKEN，无需 GitHub App、App 私钥或 PAT。该 token 创建的版本 PR 的 pull_request CI 可能需要人工批准，无法依赖它自动运行，因此工作流会显式 dispatch 现有 ci.yml 到版本 PR 的分支，检查结果对应相同 head commit。workflow_dispatch 可以由 GITHUB_TOKEN 触发；版本 PR 必须通过现有 Merge gate，由维护者合并。release-please 随后创建 `vX.Y.Z` 标签与 GitHub Release；同一工作流中的 publish job 使用该标签的提交进行验证，不发布后来新增的 main 提交。GitHub Release 已创建不代表 npm 已发布，需检查 publish job。

发布 job 拒绝非稳定版本、main 之外的标签，以及 package.json/lockfile 与标签不一致的版本。它执行构建、单元测试、演示、格式/浏览器语法、依赖审计和浏览器测试，再构建 tarball。`MR_ON_TARBALL` 让打包测试安装并验证这份 tarball，随后 npm 发布同一文件，禁用 publish 生命周期脚本。发布使用 Node 24、npm >=11.5.1 和 OIDC，不设置 NPM_TOKEN，发布构建不使用 npm 缓存。当前只发布 stable 到 latest，不处理 beta/next。

### 一次性配置

1. 在仓库 Settings → Actions → General → Workflow permissions 中，启用 Allow GitHub Actions to create and approve pull requests。工作流在 release job 内明确申请 Contents、Pull requests、Issues 和 Actions 写权限；仓库或组织策略必须允许这些权限。它只创建版本 PR 和显式触发 CI，不自动批准或合并 PR。
2. 无需配置 RELEASE_APP_ID、RELEASE_APP_PRIVATE_KEY 或 GitHub environment。若之前已配置，工作流不再使用它们。
3. 确认 npm 包名与账号权限。如果包尚不存在，需维护者先通过交互式认证完成一次引导发布并检查内容，才能在包设置中配置 Trusted Publisher。本变更不会执行该操作。0.1.0 可按下方手动流程引导；后续由 release-please 管理版本。
4. 在 npm 包的 Trusted publishing 中选择 GitHub Actions，绑定 owner `sugarforever`、repository `mr-on`、workflow filename `release.yml`、environment 留空，允许直接 publish。名称必须精确匹配。使用 GitHub-hosted runner。npm 新建信任配置需在官方规定的有效期内完成首次成功发布，否则重建配置。
5. 保留 main 的 PR 审核和 Merge gate 保护，并限制 release 标签的创建/修改权限。完成首次自动发布后，核对 npm 版本和 provenance。公开仓库与公开包通过 OIDC 发布时自动附带 provenance。

### 失败与重试

发布中断或首次配置尚未就绪时，在 Actions 的 Release 工作流选择 Run workflow，分支选 main，输入已存在的标签（例如 `v0.2.0`）。它只重试该标签的验证和发布，不再生成新版本。也可重新运行原失败 job。标签必须包含本发布工作流及校验脚本；不要对旧的引导标签使用此入口。

已成功发布的 npm 版本不能覆盖；重复执行会报错，不会自动改版本或忽略失败。先核对 registry 中是否已有该版本；若已发布，只需确认结果，不要移动标签或强推版本。若代码需要修复，提交新的修复并发布新版本。发布失败不会自动删除 GitHub Release。

### 手动引导与应急发布

先确认干净提交、版本号、账号权限及依赖许可证，再执行以下检查：

```sh
npm ci
npm run build
npm test
npm run demo
npm run format:check
npm run check:browser
npx playwright install chromium
npm run test:ui
npm audit --audit-level=high
mkdir -p release-artifacts
npm pack --json --pack-destination release-artifacts
# 使用上一步实际生成的文件名
MR_ON_TARBALL="$PWD/release-artifacts/mr-on-0.1.0.tgz" npm run test:package
npm publish release-artifacts/mr-on-0.1.0.tgz --access public --ignore-scripts
```

检查 tarball 文件清单及测试结果后再执行最后一行，通过维护者交互认证完成发布。脚本中的版本仅为初次引导示例，必须与实际包版本一致。不要在参数、日志或 PR 中放令牌。发布后核对 registry 元数据，并从无源码目录安装已发布版本。

参考：[release-please](https://github.com/googleapis/release-please-action)、[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。

显式 files allowlist 不包含开发测试产物。运行时依赖仍由 npm 解析和安装，
不是零依赖二进制；Pi SDK 含多种提供商的传递依赖。依赖审计与许可证清单应在每次发布时重新检查。
本次 lockfile 中非开发依赖许可证字段：MIT 132、Apache-2.0 38、BlueOak-1.0.0 4、
BSD-3-Clause 14、ISC 11、BSD-2-Clause 10、Unlicense 1、0BSD 1，
无缺失字段；这是元数据核查，发布前仍需复核实际许可证与再分发义务。

当前打包验证不代表已验证真实模型兼容性，也不代表已完成真实 launchd/systemd 生命周期测试。
