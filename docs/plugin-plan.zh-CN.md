# 插件演进计划（2026-11）

> **状态**：已完成（2026-11-24）。进度和验收记录在 #1065。
> **负责**：Claude 受维护者委托实现和维护。范围有变化时，先和维护者确认，再改本文。
> **依据**：#1051 的讨论；`dev@07200c6f` 的代码（2026-11-23 核对）；`ohmygame-plugins` 的市场索引任务。
> **本文分工**：第 1–3 节说明做什么、为什么；第 4–6 节说明怎么做、怎么算做完。

---

## 1. 目标

计划分两条线，按顺序做：

1. **项目级插件**：插件可以整包放进项目。只有在需要定制时，才把已安装的插件 fork 到项目里，之后由项目自己维护，不跟踪上游更新。fork 可以在聊天里让 agent 完成，也可以在界面上点按钮完成。项目里自带的扩展只有这一种格式。
2. **GitHub 发布**：插件改为通过 GitHub 仓库发布，不再使用 npm。用户从市场签过名的镜像下载：国内走镜像，海外直连 GitHub，也可以自己设置。Plugin Builder 支持登录 GitHub 后一键发布。

## 2. 已定的决策

| # | 决策 | 原因 |
| --- | --- | --- |
| 1 | 项目级插件放在 `.ohmygame/plugins/<publisher>/<name>/`，格式和已安装的插件相同。同 id 时整包使用项目里的版本，不混用两边的文件 | 共享的包保持不变，才能缓存、校验和安全更新；项目里的副本可以随意修改，才能为一个项目定制 |
| 2 | fork 沿用原来的 id，在这个项目里取代已安装的版本。设置、密钥、数据目录和页面存储都按 id 共享 | 一个项目里只有一个 TapTap Maker；不用重新填设置 |
| 3 | fork 是一次性复制，不跟踪上游，没有 `baseDigest`、对比、合并或"有新版本"提示。再 fork 一次就是覆盖（旧的改动留在 checkpoint 里）；删除副本就回到已安装的版本 | 不做过度设计 |
| 4 | agent 调用 `fork_plugin` 时直接复制，不需要确认。复制会写入 checkpoint，可以撤销 | 和 agent 写其他文件一样 |
| 5 | 有项目副本时，以副本 manifest 里的版本为准，忽略 `ohmygame.json` 对这个 id 的版本固定。旧版 app 会忽略副本，继续用已安装的版本 | 目录位置本身就说明了来源，不需要新增字段 |
| 6 | 只能在 app 级生效的贡献（模型和媒体 provider、coding agents、`sessions`），在项目副本里一律忽略，并记一条日志 | 项目不能改变整个 app 的行为 |
| 7 | **打开不等于执行**：导入的项目和打开的外部文件夹，在用户第一次点 Play 或发消息之前，不自动预览，也不加载项目插件。之后直接加载，包括 native 代码，不弹窗 | 用户点了 Play，项目自己的 `dev` 脚本本来就会运行；项目插件和项目代码同等对待 |
| 8 | 去掉 `.ohmygame/panels/` 的支持，**不迁移**。旧文件留在磁盘上，不删也不改，只是不再加载。agent 写的面板改为 `project/<name>` 项目插件 | 只保留一种格式；changelog 里写明这是破坏性变更 |
| 9 | 删除按文件夹的插件批准（`needs-approval`、`PluginGrants.projects`）和项目面板的审批。保留安装时的同意、签名和下架标记、工具钩子的"允许并记住"、花钱/发布/`sessions` 的显式流程，以及 safe mode | 权限只在安装插件时问一次 |
| 10 | 插件发布完全去掉 npm。已安装的 npm 插件继续能用，但不再更新；预装插件由新版 app 换成 GitHub 来源 | 作者几乎都有 GitHub 账号，大多没有 npm 账号 |
| 11 | 下载源：市场把包复制到 `plugins.ohmygame.ai`（R2）并签名。国内默认走镜像，海外默认直连 GitHub，用户也可以选择或填写代理前缀。app 的网络代理设置照常生效 | 公共 GitHub 代理没有服务保障，jsDelivr 在大陆被封；有签名和内容摘要，任何代理都改不了包的内容 |
| 12 | publisher 必须等于 GitHub 用户名或组织名的小写形式。`ohmygame` 只允许 WhiteTowerAI 组织使用 | 不让别人冒用 publisher |
| 13 | 作者工具 `npm create ohmygame-plugin` 和 `@ohmygame/plugin-ui` 继续放在 npm 上 | 它们是开发工具，不是插件的分发渠道 |

## 3. 不做的事

| 不做 | 什么情况下重新考虑 |
| --- | --- |
| OS 沙箱、信任弹窗、按项目授权 | 出现源码级的项目分享、agent 无人值守运行，或发生真实的安全事件 |
| 每个插件一个 native 进程 | 插件崩溃互相影响成为真实问题 |
| fork 的更新跟踪（`baseDigest`、对比、三方合并、新版本提示） | — |
| 跨插件调用、只定制单个视图、锁文件、`ohmygame.json` 的 `source` 字段 | — |
| 迁移旧的 `.ohmygame/panels/` | — |
| npm 分发（包括 npmmirror 和自定义 registry） | — |
| 声明式的新建项目向导 | 现在已经用"模板 + `ready` 面板"完成设置 |

---

## 4. 实现规则

- **一次只做一个 PR**，按第 5 节的顺序。从最新的 `dev` 拉分支，分支名用本文给的名字；PR 目标是 `dev`，标题用 Conventional Commit 格式，描述里写明对应本文哪个 PR。
- **范围**：只做本文列出的改动，第 3 节的内容哪怕顺手也不做。
- **测试先行**：先把完成标准写成会失败的测试，再实现。删除测试前，在 PR 里写明由哪个剩下的测试守护对应行为。
- **兼容**：遵循 [compatibility](compatibility.md)。决策 8 和 10 是明确的破坏性变更，在 PR 描述里写明，由发版时写进 changelog；其余存储格式的变化要在加载时迁移，兼容代码用 `compat:` 标注移除时间。
- **界面文案**：同时写进 `src/renderer/locales/en.ts` 和 `zh-CN.ts`；发给 agent 的文字用英文。
- **文档**：对外行为变化时，在同一个 PR 里更新文档（各 PR 下列出了具体文件）。
- **检查**：按 [CONTRIBUTING](../CONTRIBUTING.md#make-and-check-your-change) 跑完全部检查；界面改动要在渲染后的页面里实际看一遍。开 PR 前跑 `/code-review high`，修掉发现的问题。
- **进度**：PR 合并后，在 #1065 勾选对应的一项，并留一条进度评论。开始之前先读 #1065 的最新评论。

**遇到下面的情况就停下，先和维护者确认，不要自行调整：**

- 某条完成标准不改范围就做不到；
- 需要改本文没有列出的对外契约（manifest 字段、bridge 方法、存储格式、路由）；
- 安全行为和第 2 节不一致；
- CI 持续失败，而且看起来和本 PR 无关。

---

## 5. PR 列表

### 第一条线：项目级插件

#### PR A · `feat/open-without-running`（决策 7）

**做什么**

- 本机项目记录 `project.json`（`projects.ts` 的 `ProjectMetadata`）新增两个字段：
  - `origin`：`opened` / `imported`，在 OhMyGame 里新建的项目不记；
  - `engagedAt`：第一次主动操作的时间。
- `origin` 的写入规则：
  - `create()`：新建文件夹或选中的文件夹为空 → 不记；选中的是非空文件夹 → `opened`。示例（`examples.ts`）走这个入口，文件夹是空的，所以不记；Plugin Builder 的工作区（类型 `plugin`）也不记。
  - `import()`（来自 `project-archive.ts`）→ `imported`。
  - `duplicate()`：继承原项目的 `origin` 和 `engagedAt`。
  - 升级前的老项目，以及这个版本认不出的 `origin` 值，都按新建的项目处理。
- `engagedAt` 在两种情况下写入：
  - 用户手动启动预览（`app.ts` 的预览启动路由，`ensureStarted` / `start` 且 `manual = true`）；
  - 用户发消息（`POST /projects/:projectId/conversations/:conversationId/turns`）。
- `preview.ts` 的 `#automaticAllowed`：`origin` 是 `opened` 或 `imported`、并且没有 `engagedAt` 时，返回 `false`。
- 导出 `projectEngaged(project)`，供 PR B 使用。`ProjectState` 增加渲染端判断所需的字段。
- 界面：这类项目的预览区显示提示，例如"这个项目来自其他地方，不会自动运行。点 Play 开始"，放在 `coding-workspace.tsx` 里现有 `workspace.autoDisabled` 提示的旁边。

**测试**：`test/projects.test.ts`（各来源的 `origin`、复制时继承、老项目按新建处理）；`test/preview.test.ts` 或 `test/preview-lifecycle.test.ts`（外来项目不安装依赖、不运行 `dev`；点 Play 后正常启动；有 `engagedAt` 之后恢复自动启动；新建项目不受影响）；`test/project-archive.test.ts`。

**文档**：`docs/runtime.md`、`docs/project-archives.md`。

**完成**：导入一个带 `postinstall` 的归档，打开后既不安装依赖也不运行脚本；点 Play 或发消息之后正常运行。

#### PR B · `feat/project-plugins`（决策 1、2、5、6）

**做什么**

1. **项目索引**：新增 `src/daemon/project-plugin-index.ts`。
   - 扫描 `.ohmygame/plugins/<publisher>/<name>/`，用 `indexPluginPackage` 读取（它已经拒绝链接，并有大小和文件数上限）。
   - 按项目的 realpath 缓存，包的 digest 变了才重建。
   - manifest 的 id 和所在目录不一致时报错。
2. **项目范围放宽校验**：`checkPackage`（`plugin-index.ts`）增加一个选项，在项目范围内不强制图标（`plugin-manifest.ts` 里的 "a plugin with panels needs an icon"）、语言文件和 `engines` 的完整性。
3. **解析**：`resolveProjectPlugins()`（`project-plugins.ts`）先取项目索引，再取已安装的插件。
   - 同 id 时整包使用项目副本；`ProjectPluginState` 增加 `source: "project" | "installed"`。
   - 项目副本默认开启；`ohmygame.json` 里写 `false` 就关闭；对这个 id 的版本固定不起作用。
   - `projectEngaged` 为假时不加载项目副本。
   - 项目副本里只能在 app 级生效的贡献（`pluginAppOnly`、`isAppWidePlugin` 判定的部分，以及 `APP_SCOPE` host）忽略并记日志。
4. **审计全局索引的查找点**：`src/daemon` 里有 59 处 `index.get/latest/contributions/verify`，分布在 `app.ts` 19、`plugin-services.ts` 13、`project-types.ts` 10、`project-plugins.ts` 10、`plugin-sources.ts` 7、`plugin-setup.ts` 3、`plugin-ui-server.ts` 2、`plugin-releases.ts` 2、`preinstalled-plugins.ts` 2、`native-plugins.ts` 1。
   - 每一处要么改为使用这个项目解析出的条目，要么写明为什么保持全局（安装、市场、插件页属于这类）。
   - 必须改的：`plugin-ui-server.ts` 的页面服务、`native-plugins.ts` 的 `#ready` 校验（改为用项目索引）、Skills 的 staging、`project-types.ts` 对已有项目的解析。
   - 完整清单写进 PR 描述。
5. **监听和重载**：复用 `plugin-development.ts` 的做法：300 ms 后重新索引，重启这个插件在这个项目里的 host；页面地址带上 digest，以便刷新。只监听已打开的项目。
6. **保留 publisher `project`**：`assertAddablePlugin`（`plugin-services.ts`）拒绝从外部添加 `project/*`。
7. **界面**：插件页、项目插件面板（`project-plugins-sheet.tsx`）和插件日志标出"项目 / 已安装"；项目插件面板里可以关闭项目副本。

**测试**：`test/project-plugins.test.ts`：
- 项目副本整包覆盖已安装版本；
- 删除副本后回到已安装版本；
- 另一个项目不受影响；
- 关闭后不再生效；
- 没有主动操作过的外来项目不加载副本；
- app 级贡献被忽略；
- 版本固定被忽略。

另外：
- 项目索引：拒绝链接；id 和目录不一致时报错；放宽校验只在项目范围生效。
- `test/extension-hosts.test.ts`：项目副本的 native 代码能运行，改动后 host 会重启，校验走项目索引。
- `test/plugin-sources.test.ts`：`project/*` 不能从外部添加。

**文档**：`docs/plugins.md` 新增 "Project plugins" 一节（位置、优先级、共享的东西、被忽略的贡献、旧版 app 的行为）；`docs/plugin-security.md`（项目插件和项目代码同等对待，打开不等于执行）。

**完成**：项目副本覆盖、删除后还原、不影响别的项目；出错时可以在项目插件面板里关掉，不需要 agent 修复；外来项目在主动操作前不加载。

#### PR C · `feat/fork-plugin`（决策 3、4）

**做什么**

- daemon 新增 `forkPlugin(project, id)`：把插件当前安装的版本整包复制到 `.ohmygame/plugins/<publisher>/<name>/`，已有副本时整体替换。写入走 `PluginWrites`（`plugin-writes.ts`），所以有 checkpoint 和历史记录，可以撤销。只有 app 级贡献的插件不能 fork。
- 路由：`POST /projects/:projectId/plugins/:publisher/:name/fork`，以及 `DELETE` 同一路径（删除副本，同样走 `PluginWrites`）。
- agent 工具 `fork_plugin({ id })`：在 `agent-tools.ts`（`createAgentTools`）里和 `install_plugin` 放在一起，并加进 `activePiToolNames`，说明用英文，不需要确认。Claude Code、Codex 等 coding agents 通过 `ToolBridge` 拿到它，外部 agent 通过 `external-mcp.ts` 拿到。
- `workspace.ts`：agent 和 Code 面板能看到 `.ohmygame/plugins/`，`.ohmygame/` 下的其他内容仍然隐藏。
- `project-guides.ts` 新增 `plugins` 主题：如何定制一个插件（先 fork，再改文件），以及如何写一个 `project/<name>` 插件，附最小 manifest 示例（面板 + Skill）。
- 界面：插件详情页和项目插件面板加"复制到项目"；已有副本时显示"用已安装版本覆盖"和"删除项目副本"。

**测试**：
- 路由（放在 `test/plugin-files-api.test.ts` 或 `test/renderer-api.test.ts`）：fork、覆盖、删除、撤销。
- `test/agent-tools.test.ts`：`fork_plugin`。
- `test/workspace.test.ts`：`.ohmygame/plugins/` 可见。
- `test/agent-instructions.test.ts`：新的指南内容。
- 界面测试：几个按钮的显示条件。

**文档**：`docs/plugins.md`、`docs/external-agents.md`（新工具）。

**完成**：在聊天里说"把 TapTap Maker 的面板改成……"，agent 会先 fork 再修改，改动只影响这个项目；删除副本后恢复原版。

#### PR D · `refactor/remove-project-panels`（决策 8）

**做什么**

- 删除：
  - `project-panels.ts`、`shared/project-panels.ts`；
  - `plugin-ui-server.ts` 的 `_project` 路径；
  - 渲染端的 `ProjectPanelGate`（`project-plugin-contributions.tsx`、`project-shell.tsx`）；
  - `panel-approvals.json` 的读写；
  - `projects.ts` 和 `workspace.ts` 里对 `PROJECT_PANELS_DIRECTORY` 的特殊处理。
- 插件页面可以使用 `net.fetch`，允许的主机取自 manifest 的 `capabilities.network`（`plugin-ui-protocol.ts` 的 `PluginUiCapabilities.net`）。安装时的同意界面已经会列出 `network:<host>`（`project-plugins.ts` 的 `capabilityGrants`），所以这不会让插件悄悄多出能力。
- 项目插件页面没有被捕获的错误，写到 `.ohmygame/local/plugin-errors/<publisher>__<name>.log`，取代原来的 `panel-errors`。
- 面板工具栏的"做成插件"改为针对 `project/*` 插件：沿用 `plugin-setup.ts` 的 Builder 流程，把 `panel-to-plugin.ts` 改成复制项目插件。
- `project_guide` 去掉 `panels` 主题。如果项目里有旧的 `.ohmygame/panels/`，用户要求时 agent 可以把它改写成项目插件。
- PR 描述里写明这是破坏性变更：旧的项目面板不再加载，文件保留在原处。

**测试**：用新测试替换原来的项目面板测试（在 PR 里写明对应关系）；声明了主机的插件页面可以 `net.fetch` 到这些主机，其他主机被拒绝；错误日志能写入；agent 写的 `project/<name>` 插件保存后自动生效，不弹审批。

**文档**：`docs/plugins.md` 删除 "Project panels" 一节，改为指向 "Project plugins"；同步更新 `docs/checkpoints.md`、`docs/project-archives.md`、`docs/plugin-security.md`。

**完成**：`rg -n "ProjectPanelGate|panel-approvals|_project/" src` 没有结果。

#### PR E · `refactor/plugin-approvals`（决策 9）

**做什么**

- `project-plugins.ts`：删除 `needs-approval` 状态。项目文件里点名的插件，只要在 app 级同意过，就直接生效。
- `PluginGrants`：`GRANTS_SCHEMA` 从 2 升到 3，加载时丢弃 `projects`（标注 `compat:`）；删除 `approve` / `revoke` 里和项目相关的部分。
- 渲染端（`api.ts`、`project-plugins-sheet.tsx`、`project-plugin-contributions.tsx`、`shared/plugins.ts`、两个语言文件）：删除和审批相关的界面和类型。

**测试**：外来项目的 `ohmygame.json` 打开的、已同意的插件直接生效；`needs-consent` 的行为不变；grants 迁移只丢掉 `projects`，其他记录不受影响。同时调整 `test/plugin-files-api.test.ts`、`test/extension-hosts.test.ts`、`test/project-plugins-sheet.test.tsx`、`test/agent-instructions.test.ts`、`test/agent-tools.test.ts` 和 `test/renderer-api.test.ts` 中依赖审批的部分。

**文档**：`docs/plugin-security.md` 的 "What the person approves"；`docs/plugins.md`。

**完成**：`rg -n "needs-approval" src` 除兼容代码外没有结果。

### 第二条线：GitHub 发布

#### PR F · `ohmygame-plugins`：`feat/github-index`（决策 10–12）

**做什么**（在 `ohmygame-plugins` 仓库）

- 索引任务（`src/build-index.ts`、`.github/workflows/index.yml`）改为从 GitHub 发现插件：
  - 收录带 `ohmygame-plugin` topic 的公开仓库；
  - 只认 tag 为 `v<version>` 的 release，并且 tag 要和 manifest 的版本一致；
  - release 里有构建好的包附件就用附件，没有就用这个 commit 的源码包。
- 检查：沿用现在和 app 相同的包检查。另外要求 publisher 等于仓库 owner 的小写形式，`ohmygame` 只允许 WhiteTowerAI。
- 镜像：把包上传到 R2 的 `packages/<publisher>/<name>/<version>-<sha256>.tgz`。
- 签名：每个版本生成一条签名记录，格式沿用 app `plugin-releases.ts` 的 `Release`（id、version、url、size、sha256、key、signature），再加上 GitHub 地址和 commit。签名私钥放在仓库 secret 里。
- 新索引发布到新路径（`index` v2）。旧路径停在最后一份 npm 索引，旧版 app 仍然能读。`blocked.json`、`featured.json`、`categories.json` 沿用。
- 去掉 npm 的发现逻辑。WhiteTowerAI 自己的插件改为在 GitHub 上打 tag 发布（`publish.yml`）。

**测试**：仓库现有的 vitest 用例：发现、tag 和版本不一致、publisher 和 owner 不一致、签名、镜像路径。

**完成**：v2 索引里列出现有官方插件的 GitHub 版本，每个版本都有签名，R2 上能下载到。

#### PR G · `refactor/plugins-from-github`（决策 10、11）

**做什么**

- `plugin-market.ts` 改读 v2 索引。安装时用 `verifyReleaseSignature` 加上 app 内置的市场公钥校验，取代 npm 签名。
- **下载源设置**放在现有的 Plugin sources 对话框里（`plugin-market-settings.ts`）：
  - 选项：自动 / GitHub 直连 / OhMyGame 镜像 / 自定义代理前缀；
  - "自动"：中文界面或在国内时先走镜像，否则先走 GitHub，失败了再试另一个；
  - 下载都经过现有的网络代理设置。
- 静默更新的条件从"有 npm 签名"改为"有市场签名"。检查市场插件的更新只读索引，不调用 GitHub API。
- Add plugin：去掉 npm 来源和 registry 选择，保留 GitHub URL、本机文件夹和 `.tgz`。手动添加的 GitHub 插件仍然直接查 GitHub，但降低检查频率，避免触发 60 次/小时的匿名限额。
- 预装插件：`config/preinstalled-plugins.json` 改为锁定签名的 GitHub release。
  - 现有的 `installPreinstalled` 会拒绝换来源（"cannot reuse data from another plugin source"）。
  - 所以要在 `isSameSource` 里新增一条规则：`@ohmygame/*` 的 npm 来源和 WhiteTowerAI 的 GitHub release 算作同一来源。这样换来源后，设置和授权都会保留。
  - 这条规则只适用于 `ohmygame` publisher，第三方插件不适用。
- 第三方 npm 插件：继续能用，插件页提示"这个来源已停止更新，重新安装可以获得更新"。

**测试**：`test/plugin-market.test.ts`、`test/plugin-sources.test.ts`、`test/plugin-catalog-api.test.ts`、`test/plugin-catalog-view.test.tsx`：签名校验、镜像失败后回落、自定义前缀、包被篡改时拒绝安装、预装插件换来源后设置保留。

**文档**：`docs/plugins.md` 的 Adding a plugin、Updates、The plugin market、Preinstalled 几节；`docs/plugin-security.md` 的供应链部分。

**完成**：`rg -n "registry.npmjs|npmmirror" src` 只剩作者工具相关的内容；国内、海外两种设置下都能安装和更新。

#### PR H · `feat/builder-publish-github`（决策 12）

**做什么**

- GitHub device flow 登录，使用 WhiteTowerAI 的 OAuth App（device flow 不需要 client secret）。token 存在本机的密钥存储里，权限范围是 `public_repo`。
- Plugin Builder 新增"发布到 GitHub"：
  - publisher 换成登录用户名的小写形式（`personal/x` → `<login>/x`，原来的 personal 版本保留，由用户自己删除）；
  - 用 GitHub API 建仓库或更新已有仓库、提交文件（不要求本机装 git），加上 `ohmygame-plugin` topic；
  - 打 tag `v<version>`，创建 release，并附上 `plugin-pack.ts` 打出的包。
- 导出模板（`plugin-template.ts`）：npm 发布工作流换成"打 tag 后构建并上传到 release"。

**测试**：在模拟的 GitHub API 上测试：登录、建仓库、重复发布、版本号已存在、token 失效。

**文档**：`docs/plugins.md` 的 Making a plugin、Tools for plugin authors。

**完成**：在 Builder 里登录 GitHub、点击发布后，半小时内能在市场里看到并安装这个插件（取决于索引任务实际的运行频率）。

---

## 6. 整体验收

每条线做完后，由一个**新会话**（不是写代码的那个）逐条核对并给出证据：

- **第一条线**（A–E）：
  - PR A–E 的"完成"一项，各自对应的测试名；
  - 第 3 节的内容都没有实现；
  - `docs/plugins.md`、`docs/plugin-security.md`、`docs/runtime.md`、`docs/project-archives.md` 和实现一致；
  - 在桌面版（`bun run dev:desktop`）里手动验证并截图：
    - 导入一个 Web 游戏归档，不自动安装依赖；
    - 在聊天里让 agent fork TapTap Maker 并改它的面板，只影响这个项目，删除副本后恢复原版；
    - agent 写一个面板加一个 Skill，不弹审批，立刻能用；
    - 中英文、明暗主题下各看一遍。
- **第二条线**（F–H）：
  - 从镜像、直连和自定义代理三种方式各安装一个市场插件；
  - 一个被篡改的包被拒绝安装；
  - 从 Builder 发布一个新插件，并在另一台机器上安装它；
  - 旧版 app 仍然能读旧索引。
- 全部完成后：本文状态改为"已完成"，删除 `AGENTS.md` 里指向本文的那一行。

## 7. 进度

进度在 #1065 跟踪。顺序：A → B → C；B 合并后，D 和 E 可以并行；第一条线做完后，再做 F → G → H。

## 8. 需要维护者提供的东西

- **PR F 之前**：
  - 市场签名的密钥对：私钥放进 `ohmygame-plugins` 的 secret，公钥内置到 app；
  - 确认 R2 的存储和流量费用可以接受（单个包最大 50 MB）。
- **PR H 之前**：在 WhiteTowerAI 组织下创建 GitHub OAuth App 并开启 device flow，把 client id 提供给实现。
