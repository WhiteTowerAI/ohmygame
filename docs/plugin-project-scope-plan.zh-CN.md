# 项目级插件：实现计划

> **依据**：[决策记录](plugin-project-scope.zh-CN.md)（冻结）和 #1051。
> **本文分工**：决策记录说明"做什么、为什么"；本文说明"怎么做、怎么算做完"。
> **修改权限**：实现时**只允许更新第 6 节"进度"**。其余内容要修改，需要先在 #1051 提出、经维护者确认（决策记录第 7 节）。

---

## 1. 每次开始工作前

1. 读 `AGENTS.md`、`CONTRIBUTING.md`、决策记录、本文，以及 #1051 的最新评论。
2. 在第 6 节找到下一个未完成的 PR，**一次只做一个**。
3. 从最新的 `dev` 拉分支，分支名用本文给定的名字；PR 目标是 `dev`，标题用 Conventional Commit 格式。

## 2. 全局规则

- **范围**：只做本文列出的改动。决策记录第 6 节列出的"不在范围内"一律不做，哪怕顺手。
- **测试先行**：每个验收标准先写成会失败的测试，再实现。
- **删代码**：删除测试前，先在 PR 里写明由哪个剩下的测试守护对应行为（`CONTRIBUTING.md` 的要求）；必要时跑 `bun run test:ablation`。
- **兼容**：改动存储数据时遵循 `docs/compatibility.md`——在加载处迁移、读不懂的数据不覆盖、兼容代码用 `compat:` 标注移除时间。
- **界面文案**：新增文案同时写进 `src/renderer/locales/en.ts` 和 `zh-CN.ts`；发给 agent 的文字用英文。
- **文档**：对外行为或文件契约变了，同一个 PR 里更新文档（各 PR 下面列了具体文档）。
- **检查**：每个 PR 合并前本地全部通过：
  ```bash
  bun run prepare:preinstalled-plugins && bun run changelog:check && bun run typecheck && bun run lint && bun run test && bun run build:renderer && bun run test:node-runtime
  ```
  开发时可以先跑单个测试，例如 `bun run test -- test/project-plugins.test.ts`。
- **评审**：跑 `/code-review high`，修掉发现的问题；在 PR 描述里写清改了什么、为什么、怎么验证的、哪些检查或手动验证没做。
- **进度**：PR 合并后，更新本文第 6 节，并在 #1051 留一条进度评论。

### 遇到以下情况必须停下，回 #1051 提出，不要自行调整

- 某个验收标准不改范围就做不到；
- 需要改本文没列出的对外契约（manifest 字段、bridge 方法、存储格式）；
- 需要删除一个守护现有行为、却找不到替代测试的测试；
- 安全行为要和决策记录不一样；
- CI 持续失败，且看起来与本 PR 无关。

---

## 3. 决策第 4 项的实现澄清

- **决策原文**："导入的项目默认 `previewAutoStart = false`"。
- **问题**：`previewAutoStart` 存在项目的 `.ohmygame/settings.json` 里（`PREVIEW_SETTING_KEYS`），会跟着项目走。改它会在用户仓库里产生 diff，也会把设置带给别人。
- **实现**：在**本机**的项目记录里（数据目录下的项目记录，不是项目文件夹）记两件事：
  - `origin`：`created` / `opened` / `imported` / `example`；
  - `engagedAt`：用户第一次点 Play 或发消息的时间。
- **判定**："没有主动操作过的外来项目" = `origin` 是 `opened` 或 `imported`，且没有 `engagedAt`。
- 决策意图不变。

---

## 4. PR 列表

### PR 0 · `docs/plugin-project-scope`：把计划放进仓库

- 新增 `docs/plugin-project-scope.zh-CN.md`（决策记录）和 `docs/plugin-project-scope-plan.zh-CN.md`（本文）。
- `AGENTS.md` 加一行：
  > Plugin project-scope work (#1051) follows the frozen decision in docs/plugin-project-scope.zh-CN.md and its implementation plan. Do not change their scope in a PR; raise conflicts on the issue first.
- `docs/README.md` 加上这两份文档的入口。
- **完成**：文档类检查通过（`git diff --check`、链接有效）。

### PR 1 · `feat/open-without-running`：打开不等于执行（决策第 4 项）

**做什么**

- 在本机项目记录里加 `origin` 和 `engagedAt`（见第 3 节）：
  - `projects.ts` 的 `create()`：在空文件夹或新文件夹里新建 → `created`；选中的是已有的非空文件夹 → `opened`；
  - `import()` 和 `project-archive.ts` 的导入 → `imported`；
  - 内置示例和 Remix → `example`；
  - 升级前已有的项目没有 `origin`，按 `created` 处理，不打扰老用户。
- 记录 `engagedAt`：用户手动启动预览（`ensureStarted` 或 `start` 且 `manual = true`）或发出第一条消息时写入。
- `preview.ts` 的 `#automaticAllowed`：没有主动操作过的外来项目，返回 `false`。
- 界面：这类项目的预览区显示一句提示，例如"这个项目来自其他地方，不会自动运行。点 Play 开始"。可以参考现有的 `workspace.autoDisabled` 提示。
- 提供一个函数，例如 `projectEngaged(project)`，供 PR 2 判断是否加载项目级插件。

**测试**

- `test/projects.test.ts`：各种来源写入正确的 `origin`；老项目按 `created` 处理。
- `test/preview-lifecycle.test.ts` 或 `test/preview.test.ts`：
  - 外来项目在主动操作前不自动启动，因此不会安装依赖、不会运行 `dev` 脚本；
  - 点 Play 后正常启动；
  - 有了 `engagedAt` 之后恢复自动启动；
  - 新建项目的行为不变。
- `test/project-archive.test.ts`：导入后 `origin = imported`。

**文档**：`docs/runtime.md`（预览自动启动）、`docs/project-archives.md`（导入后的行为）。

**完成**：决策验收标准 4 中关于预览的部分通过。

---

### PR 2 · `feat/project-plugins`：项目级插件 + "复制到项目"（决策第 1 项）

**做什么**

1. **项目索引**：新增模块，例如 `src/daemon/project-plugin-index.ts`。
   - 扫描 `.ohmygame/plugins/<publisher>/<name>/`，用 `indexPluginPackage` 读取（它已经拒绝链接，也有大小和文件数上限）；
   - 按项目的 realpath 缓存，包的 digest 变了才重建。
2. **放宽校验**：`checkPackage` 加一个项目范围的选项——不强制图标（`plugin-manifest.ts` 里"a plugin with panels needs an icon"的校验）、语言文件和 `engines` 的完整性；id 以 manifest 为准，manifest 的 id 和所在目录 `<publisher>/<name>` 不一致时报错。
3. **解析**：`resolveProjectPlugins()` 先取项目索引，再取用户级索引。
   - 同 id 时项目级整包覆盖用户级；
   - `ProjectPluginState` 和插件条目加 `source: "project" | "user"`；
   - 项目级插件默认开启，可以在项目的插件面板里关掉（写进 `ohmygame.json` 的 `false`）；
   - 没有主动操作过的外来项目（PR 1 的 `projectEngaged`），项目级插件不加载。
4. **监听和重载**：复用 `plugin-development.ts` 的做法（300 ms 去抖、重新索引、重启该插件在该项目的 host、面板地址带 digest 以便刷新）。只监听已打开的项目。
5. **native**：`native-plugins.ts` 的 `#ready` 遇到项目级条目时，用项目索引校验，不走全局的 `this.#index.verify`。数据目录、设置和密钥按 id 共享（决策如此）。
6. **保留 publisher `project`**：`assertAddablePlugin` 拒绝从外部添加 `project/*`，和现在的 `personal`、`ohmygame` 一样。用"从本机文件夹添加"做成插件时，提示把 publisher 改掉。
7. **"复制到项目"**：
   - daemon 路由，例如 `POST /projects/:projectId/plugins/:publisher/:name/copy`，把已安装版本的包复制到 `.ohmygame/plugins/<publisher>/<name>/`；
   - 已经存在时需要确认覆盖；
   - 走现有的项目写入流程，让 checkpoint 和撤销覆盖到这次复制；
   - 界面：插件详情页和项目插件面板加"复制到项目"（已存在时显示"用已安装版本覆盖"）。
8. **标出来源**：插件页、项目插件面板、插件日志标出"项目 / 用户"。

**测试**

- `test/project-plugins.test.ts`：
  - 项目级覆盖用户级，整包覆盖、不混用文件；
  - 删除项目副本后回到用户级版本；
  - 另一个项目不受影响；
  - 在面板里关掉后不再生效；
  - 没有主动操作过的外来项目不加载项目级插件。
- 项目索引：链接被拒绝；目录和 id 不一致时报错；放宽校验只在项目范围生效。
- `test/extension-hosts.test.ts`：项目级 native 插件能运行；文件改动后 host 重启；校验走项目索引。
- `test/plugin-sources.test.ts`：`project/*` 不能从外部添加。
- 复制路由（放在 `test/plugin-files-api.test.ts` 或 `test/renderer-api.test.ts`）：复制、需确认的覆盖、撤销。

**文档**：`docs/plugins.md` 新增 "Project plugins" 一节（位置、优先级、复制、更新方式、保留 publisher）；`docs/plugin-security.md`（项目级插件和项目代码同等对待，打开不等于执行）。

**完成**：决策验收标准 1、5 通过；验收标准 4 中关于项目级插件的部分通过。

---

### PR 3 · `refactor/project-panels-as-plugins`：项目面板并入（决策第 2 项）

**做什么**

1. **插件页面可以用 `net.fetch`**：插件页面的能力里，`net` 取自 `capabilities.network` 的主机（`plugin-ui-protocol.ts` 的 `PluginUiCapabilities.net`，现在只有项目面板能用）。daemon 发请求时的主机检查不变。
2. **页面报错日志**：项目级插件页面没有被捕获的错误，写到 `.ohmygame/local/plugin-errors/<publisher>__<name>.log`，让 agent 能读。行为和现在的 `.ohmygame/local/panel-errors/` 一致。
3. **迁移**：项目加载时，对每个有效的 `.ohmygame/panels/<name>/`——
   - 按 `panel-to-plugin.ts` 的规则转换成 `.ohmygame/plugins/project/<name>/`，`net` 转成 `capabilities.network`；
   - 页面存储从 `_project__<name>` 复制到 `project__<name>`；
   - 无效的面板保持原样，不覆盖读不懂的数据；
   - 兼容代码用 `compat:` 标注移除时间。
4. **删除独立流程**：
   - `project-panels.ts` 和 `shared/project-panels.ts` 的面板列表、审批、`panel-approvals.json`（迁移后）；
   - `plugin-ui-server.ts` 的 `_project` 路径；
   - 渲染端的 `ProjectPanelGate`。
   - 面板工具栏的"做成插件"改为针对项目级插件（走现有的 Builder 流程或"从本机文件夹添加"）。
5. **可见性和指南**：
   - `workspace.ts`：对 agent 和 Code 面板显示 `.ohmygame/plugins/`，替代 `.ohmygame/panels/`；
   - `project-guides.ts`：`panels` 主题改写为在 `.ohmygame/plugins/project/<name>/` 里写插件，附一个最小 manifest 示例（面板 + Skill）。

**测试**

- 迁移：带 `net` 和报错日志的旧面板迁移后行为不变；无效面板保持原样；页面存储随迁移复制。
- 声明了 `capabilities.network` 的插件页面可以 `net.fetch` 到声明的主机，到其他主机被拒绝。
- `test/workspace.test.ts`：`.ohmygame/plugins/` 可见，`.ohmygame/` 下其他内容仍然隐藏。
- `test/agent-instructions.test.ts` 或 `test/agent-tools.test.ts`：新指南内容正确。
- agent 写的面板和 Skill 保存后自动生效，不弹审批。
- 替换或删除原来的项目面板测试，并在 PR 里写明由哪些测试接替。

**文档**：`docs/plugins.md` 的 "Project panels" 一节改为指向 "Project plugins"；`docs/checkpoints.md` 和 `docs/project-archives.md` 里提到面板的地方一并更新。

**完成**：决策验收标准 2、3 通过。

---

### PR 4 · `refactor/plugin-approvals`：权限减法（决策第 3 项）

**做什么**

- `project-plugins.ts` 删除 `needs-approval` 状态。项目文件里点名的插件，只要用户在 app 级同意过，就是 active。
- `PluginGrants`：`GRANTS_SCHEMA` 升到 3，加载时丢弃 `projects`（迁移，用 `compat:` 标注）；删除 `approve` / `revoke` 的项目部分和相关调用。
- 渲染端：项目插件面板里与审批相关的界面全部删除。
- 保留：安装时同意（`needs-consent`）、市场签名和下架标记、工具钩子和"允许并记住"、safe mode。

**测试**

- `test/project-plugins.test.ts`：外来项目的 `ohmygame.json` 打开的已同意插件直接 active；`needs-consent` 行为不变。
- grants 迁移：旧文件里的 `projects` 被丢弃，其他决定不受影响。
- 调整 `test/plugin-files-api.test.ts`、`test/extension-hosts.test.ts`、`test/project-plugins-sheet.test.tsx` 里依赖审批的部分。

**文档**：`docs/plugin-security.md` 的 "What the person approves" 一节改写；`docs/plugins.md` 里提到按文件夹批准的地方。

**完成**：代码里搜不到 `needs-approval`、`panel-approvals`、`PluginGrants.projects`（兼容代码除外），并且所有检查通过。

---

## 5. 整体验收（全部 PR 合并后）

由一个**新会话**做最终核对，不是写代码的那个会话。逐条给出证据：

1. 决策记录第 5 节的 5 条验收标准，每条对应的测试名或手动验证记录。
2. 删除是否完成：
   ```bash
   rg -n "needs-approval|panel-approvals|ProjectPanelGate|_project/" src
   ```
   除兼容代码外应为空。
3. 范围检查：确认没有实现决策记录第 6 节的任何一项（OS 沙箱、信任弹窗、`source` 字段、锁文件、`baseDigest` 等）。
4. 文档：`docs/plugins.md`、`docs/plugin-security.md`、`docs/runtime.md`、`docs/project-archives.md` 与实现一致。
5. **手动验证**，在桌面版（`bun run dev:desktop`）里由人完成，或用截图记录：
   - 导入一个 Web 游戏归档：不自动安装依赖；点 Play 后正常运行；
   - 把 TapTap Maker 复制到项目，修改它的面板：只影响这个项目；删除副本后恢复原版；
   - 让 agent 写一个面板和一个 Skill：不弹审批，立即可用；
   - 打开一个有旧 `.ohmygame/panels/` 的项目：迁移后面板照常工作；
   - 中英文、明暗主题下的界面截图。
6. 结果贴到 #1051。决策记录的状态改为"已实现"，然后关闭 issue。

---

## 6. 进度（实现时只更新这一节）

| PR | 分支 | 状态 | 链接 | 备注 |
| --- | --- | --- | --- | --- |
| 0 | `docs/plugin-project-scope` | 进行中 | 本 PR | |
| 1 | `feat/open-without-running` | 未开始 | | |
| 2 | `feat/project-plugins` | 未开始 | | |
| 3 | `refactor/project-panels-as-plugins` | 未开始 | | |
| 4 | `refactor/plugin-approvals` | 未开始 | | |
| 整体验收 | — | 未开始 | | |

---

## 附：给本地 Claude 的启动提示（每个 PR 开一个新会话）

```text
Read AGENTS.md, CONTRIBUTING.md, docs/plugin-project-scope.zh-CN.md and docs/plugin-project-scope-plan.zh-CN.md, and the latest comments on WhiteTowerAI/ohmygame#1051.
Implement only the next unfinished PR in section 6 of the plan, exactly as scoped there. Write the acceptance tests first.
Do not change the decision or the plan except the progress table. If a stop condition in section 2 applies, stop and write up the problem for #1051 instead of adjusting the scope.
Before opening the PR, run all checks listed in section 2 and /code-review high, fix findings, and describe what changed, why, how it was verified, and what was not verified.
```
