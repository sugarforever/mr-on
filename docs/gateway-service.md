# Gateway 后台服务

mr-on 的 Gateway 就是现有 Node/Express 服务：监听本机 API、接收 webhook、调度 SQLite 计划，并在需要时通过 Pi 执行模型。浏览器不是调度器；关闭页面不会停止后台任务。空闲时不持续调用模型。

## 安装与管理

需要先安装依赖并构建。在仓库目录执行：

```bash
npm ci
npm run build
npm run service -- install --dry-run
```

预览只输出配置文件路径、内容与原生命令，不创建目录、不安装、不启动服务。确认路径后，由你执行真正安装：

```bash
npm run service -- install
npm run service -- status
npm run service -- logs
```

安装会写入用户服务定义并启动服务。只支持普通用户，不使用 sudo，不覆盖现有定义。应用与 Node 使用当前的绝对路径；不要在运行中移动仓库或删除这版 Node。通过 nvm 等更新 Node 路径后，需要停止、卸载，再用新的 Node 重新安装。

默认沿用仓库 `.data`，不会悄悄换一个空数据库；也可以明确指定：

```bash
npm run service -- install --data /absolute/path/to/mr-on-data --port 4317 --dry-run
```

去掉 `--dry-run` 才会安装。`--data` 相对调用命令时的目录解析；后台运行时已固化为绝对路径。以后 start/stop 等控制命令按固定服务名称操作，不需要重复传入数据路径。一个用户仅支持一个已安装的 mr-on Gateway。

其他管理命令：

```bash
npm run service -- stop
npm run service -- start
npm run service -- restart
npm run service -- uninstall
```

`stop` 停止托管服务，不会被 KeepAlive/Restart 立即拉起；`start` 恢复。macOS `restart` 先 bootout 优雅停止，再 bootstrap 启动，不使用强杀式 kickstart。`uninstall` 停止并删除定义，保留数据。原生命令失败时退出非零并保留定义供排查；不要用重复安装来修复错误。`status` 显示系统服务管理器状态；应用就绪状态另用下方探测确认。

安装前先停止当前终端中的前台服务，避免端口或数据锁冲突。不同数据目录也不能占用同一个端口。开发用 `npm run dev`，后台服务运行构建后的 `dist`，不会自动重载源码。

## 平台边界

| 平台  | 托管方式                                        | 自动启动与限制                                                                  |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| macOS | `~/Library/LaunchAgents/ai.mr-on.gateway.plist` | 用户登录时启动，关闭终端不影响；退出登录后停止。不是登录前系统守护              |
| Linux | `~/.config/systemd/user/mr-on-gateway.service`  | systemd 用户服务；登出后持续运行或开机未登录时启动需要管理员启用该用户的 linger |

Linux 上可用 `loginctl show-user "$USER" -p Linger` 查看。是否执行 `sudo loginctl enable-linger USERNAME` 由管理员决定；安装命令不自动启用。无用户 systemd/DBus 的精简容器不支持此安装方式。

macOS 配置 RunAtLoad、KeepAlive 和 10 秒启动节流；Linux 配置 Restart=always、5 秒重启间隔、五分钟最多十次启动。Linux 达到频率上限后需修复原因，再由管理员或用户执行 `systemctl --user reset-failed mr-on-gateway.service` 并 start。

这两种方式都不保证宿主机休眠、关机或断网期间执行任务或接收网络事件。要独立于笔记本开关运行，将相同 Gateway 部署到常在线 Linux 主机。当前不安装系统级 LaunchDaemon 或 systemd 系统服务。

## 健康、状态与日志

```bash
curl --fail http://127.0.0.1:4317/healthz
curl --fail http://127.0.0.1:4317/readyz
```

`healthz` 证明 HTTP 进程有响应。`readyz` 要求数据库可查询、至少完成一次调度 tick、最近心跳小于五秒且服务不在停止中，否则返回 503。模型或网站不可达会导致任务失败，不会仅因此让进程健康检查失败。健康探测不调用模型。探测端口需对应安装时的配置。

页面侧栏显示最近调度心跳和研究队列长度；悬停服务状态可查看启动、最近完成、最近成功检查和最近失败时间。这些执行时间来自持久运行记录，研究并发仍最多两个；画像使用原有独立队列。页面失联后显示“状态未知”与最后连接时间，不据此断言服务器已经停止。

stdout/stderr 输出带时间的 JSON 生命周期日志，包含启动、停止、监听失败、调度错误和停止超时，不输出模型密钥或请求正文。任务级结果与错误继续在 SQLite 和“执行记录”页面查看。

Linux 日志由 journal 管理并沿用系统保留策略。macOS 输出到数据目录 `logs/gateway.log` 和 `logs/gateway.error.log`，首版不自动轮转；无人值守长期使用前应配置系统日志轮转，或定期停止服务后归档日志，避免磁盘增长。数据目录权限 0700，服务定义 0600，进程 umask 0077。

## 恢复、停止与升级

- 已确认的事件收件和入队仍在同一 SQLite 事务内提交，eventId 重投不会重复入队。未送达本机的事件没有本地持久记录。
- queued 重启后继续；running 重启后标记 interrupted，仍需手动重试。Pi 会话历史不是工具级精确检查点，重试可能再次调用模型。
- 错过多个周期合并一次补查；读取的是恢复后的正文，不能重建停机期间所有中间版本。一次性计划保留原有暂停和入队规则。
- 网络读取与模型仍使用现有有限重试，不增加无限自动重放。服务重启不会自动重试所有失败任务。
- 停止时拒绝新写入、停止领取新工作、关闭 SSE，等待 HTTP 请求和当前执行，之后关闭 SQLite 并释放进程锁。100 秒仍未退出会终止进程；系统服务外层给 120 秒。下次启动按 interrupted 规则处理。

升级顺序：stop → 确认服务停止 → 备份完整数据目录 → 安装依赖并 build → start → 检查 readyz 与执行记录。不要在正在运行的 dist 上直接覆盖升级，也不要同时运行新旧服务。

备份必须在服务停止后复制整个目录，包含 SQLite/WAL、Pi 会话和 webhook 令牌。API Key 仍保存在 SQLite 中且无应用层加密；备份也需要相同访问保护。目前 Pi 会话引用绝对路径；本阶段不支持将备份直接迁移到不同数据路径，恢复时应保持原绝对路径。卸载不删除数据。

## 人工验收

自动测试不在开发机器安装 launchd/systemd 服务。部署到选定环境后，还需人工完成：安装并关闭终端、杀进程确认自动重启、重新登录或重启主机确认自动启动、停止后确认不被拉起、检查日志权限与保留、休眠后确认合并补查。Linux 未启用 linger 时，不应声称已通过未登录启动验收。

参考：[Apple launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)、[systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[loginctl linger](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)。
