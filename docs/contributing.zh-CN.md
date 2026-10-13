# 贡献快速指引

欢迎提交问题复现、文档改进、小修复、插件，以及实际制作游戏时的反馈。
[CONTRIBUTING.md](../CONTRIBUTING.md) 是完整贡献规范；本文提供中文入口。

## 选择任务

先搜索已有 Issue。新功能和大改动先在 Issue 中讨论，明确范围；简单修复和
文档纠错可以直接发 PR。可以关注 `good first issue` 和 `help wanted` 标签，
没有合适任务时，也可以提出你想做的改进。

## 开始开发

日常贡献从上游 `dev` 建分支，PR 的目标也是 `dev`。`main` 用于维护者发布。
Fork 仓库后，把下面的 `YOUR_USERNAME` 换成你的 GitHub 用户名：

```bash
git clone https://github.com/YOUR_USERNAME/ohmygame.git
cd ohmygame
git remote add upstream https://github.com/WhiteTowerAI/ohmygame.git
git fetch upstream
git switch --no-track -c fix/short-description upstream/dev
bun install --frozen-lockfile
bun run dev
# 桌面开发改用 bun run dev:desktop
```

需要 Git、Bun 1.4.2+ 和 Node.js 22.19+（包含 npm）。浏览器开发地址是
<http://127.0.0.1:43120>。首次启动会联网准备插件和示例。

普通本地开发和公共检查无需配置 Supabase、私有云仓库或模型密钥。缺少
Supabase 配置时，本地开发支持调试账户和临时本地发布。测试真实 Agent 对话
或媒体生成时，再连接对应模型；桌面游戏测试需要 Electron 开发模式。

代码、文档和测试入口见[文档索引](README.md#where-to-change-things)。
可选配置和常见启动问题见[完整开发指南](../CONTRIBUTING.md#start-local-development)。

## 检查与 PR

纯文档改动检查链接、示例和格式，并运行 `git diff --check`。
应用行为、依赖或 CI 改动运行公共检查；其他贡献类型的要求见
[验证说明](../CONTRIBUTING.md#make-and-check-your-change)：

```bash
bun run prepare:preinstalled-plugins
bun run typecheck
bun run test
bun run build:renderer
bun run test:node-runtime
```

私有云仓库不可用时，远端发布契约测试会跳过。在 PR 中写明跳过情况，相关
云端验证由有访问权限的维护者补充。CI 仍会检查文档 PR。

每个 PR 聚焦一件事。分支前缀使用 `feat/`、`fix/`、`docs/`、`chore/` 或
`refactor/`；PR 标题使用 Conventional Commits，例如
`docs(contributing): clarify local setup`。

填写 PR 模板，说明改了什么、为什么改、如何验证，关联相关 Issue，并记录
尚未完成的检查。UI 改动附截图或短录屏。显式选择上游 `dev` 作为目标分支；
GitHub 在分支迁移期间仍可能默认选择 `main`。

可以先发 Draft 获取反馈，完成后标记为可评审。评审中的后续修改继续推送到
同一个贡献分支；遇到阻碍，在 PR 中说明。

安全问题请按照 [SECURITY.md](../SECURITY.md) 私下报告。贡献遵循仓库的
[Apache 2.0 许可](../LICENSE)。
