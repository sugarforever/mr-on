# 合并检查

每个 PR 和 main 更新都会运行 CI，不设置路径过滤，文档或 skill 变化也必须经过检查。

| 检查                      | 覆盖范围                                                                     |
| ------------------------- | ---------------------------------------------------------------------------- |
| Quality                   | 源码、UI、测试、skill、文档和 workflow 的格式；浏览器 JS 语法；diff 空白错误 |
| Tests (22.19.0 / 24 / 26) | 最低支持版本及两个后续主版本的 TypeScript 构建、单元/集成测试和离线演示      |
| Browser                   | Chromium 中的真实 UI 流程和移动布局；确认测试不修改已跟踪文件                |
| Dependency audit          | 所有锁定依赖的已知 high/critical 漏洞，包括开发依赖                          |
| Merge gate                | 上述各组必须全部成功，失败、跳过或取消都不会通过                             |

测试不用真实 API Key，不开放外部通知。浏览器失败时保留 trace、截图和 HTML 报告，产物保留七天。CI 截图写入 test-results，不覆盖仓库中的产品预览。

Actions 固定完整 commit SHA，工作流令牌只有 contents:read，不持久保存 checkout 凭据；PR 代码不通过 pull_request_target 获得额外权限。任务有超时，更新提交会取消同一 PR 的过期运行。

建议在 GitHub main 分支规则中将 “Merge gate” 设为必需检查并要求分支与主线同步。该配置属于仓库设置，提交 workflow 不会自动开启分支保护。人工仍需审核实际需求、工具权限、敏感信息和无法由离线 fixture 证明的在线模型行为。

本地可依次运行 npm run format:check、npm run check:browser、npm run build、npm test、npm run demo 和 npm run test:ui。依赖审计运行 npm audit --audit-level=high，审计依赖 npm registry 的当前公告，发现问题应处理或给出具体、有期限的例外，不能直接忽略失败。
