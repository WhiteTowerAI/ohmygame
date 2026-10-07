# Bun 迁移实验（2026-10-07）

已在本地 `chore/bun-runtime` 分支完成工具链、独立 Daemon、桌面内置运行时和新工作区默认工具的 Bun 迁移。基线是 `eb56e5d942180980122b8b94cf159d679c89cbd9`。Electron 主进程和 preload 继续使用 Electron 自带的 Node.js，这是 Electron 的运行方式。

建议先采纳 Bun 包管理与工具链迁移，再决定是否发布完整 Daemon 迁移。以下保留当时的独立进程和工具链实验数据；后续核对发现桌面 Node 基线和测试 worker 版本需要更正，最新采用结论与真实桌面 Daemon 对比见 [工具链采用报告](bun-toolchain-2026-10-07.md)。完整迁移分支适合继续验证，目前的结果不足以证明应用整体会明显更快或更省内存。

## 实际迁移范围

- 以当前 `package-lock.json` 导入并更新 `bun.lock`，删除 npm 锁文件，移除 `tsx`，显式声明 `dotenv` 和 `model-viewer` 需要的 `three`。`bunfig.toml` 强制脚本使用 Bun，并关闭自动 peer 安装，以延续原 CI 的 `--legacy-peer-deps` 策略。
- 开发、构建、Vitest、辅助脚本、CI 和桌面发布工作流改用 Bun。保留 TypeScript 编译器以及 Vite/esbuild，不同时替换构建器或测试框架。
- Electron 使用独立 Bun 子进程启动 Daemon，保留健康检查、鉴权和私有 IPC。发布包内置经过 SHA-256 校验的 Bun 1.3.11，Daemon、共享代码、Player 和生产依赖从 ASAR 解包，供 Bun 使用真实文件路径读取。
- 使用显式 dotenv 加载器维持环境文件优先级；针对 Bun 的原生 fetch 适配代理和本地地址绕过规则。
- 无锁文件的新工作区默认使用 Bun；预览和构建传入 `--bun`。已有 npm/pnpm/Yarn 锁文件、项目设置，以及明确配置的 Pi 包管理命令继续有效。
- 内置示例使用 Bun 安装、构建和锁文件；托管 Godot MCP 使用 `bun x --bun`。更新使用说明和开发命令。

完整迁移有一项用户可见的取舍：桌面应用不再附带独立 Node/npm。已有 npm/pnpm/Yarn 工作区，以及用户配置的 `npx`、`node` MCP 命令，需要用户自行安装相应工具。默认新项目和内置示例已验证可以仅依靠随包 Bun 工作。

## 测量方法

机器为 Apple M4、24 GiB 内存、macOS 15.6.1 ARM64。工具链主对比使用本机 Node 24.14.1/npm 11.11.0 与 Bun 1.3.11 启动器；实际子进程版本见文末审计；另对旧桌面包附带的 Node 22.19.0 进行独立进程参考对比。Electron 为 43.3.0。

补充核对：原桌面 Daemon 由 Electron 可执行文件通过 `ELECTRON_RUN_AS_NODE=1` 启动，使用 Electron 内置的 Node 24.18.1；附带的 Node 22.19.0 用于工作区和 MCP 命令。下表中的独立 Node 进程数据不等于原桌面 Daemon 的实际数据，尤其不能将 Node 22 的 +45.1% RSS 差异直接归为桌面迁移后的增幅。

基线代码通过 `git archive` 保存到 `.runtime/bun-migration/baseline`，使用原 npm 安装的依赖；迁移代码复制到独立目录，使用干净的 frozen Bun 安装。构建环境不复制本地 `.env`，并移除代理、服务地址和用户配置相关的环境变量。两边使用相同的预装插件与示例资源。测试均指定同一个相邻 `ohmygame-cloud` 仓库，版本为 `cd580f5654e37810dddc63642c1f54b17c3255b0`，以执行完整的云端发布契约测试。

安装、类型检查、完整构建、完整测试各重复三次，交替执行顺序，执行时没有并行运行其他构建或测试。安装均在新的临时目录执行，保留各工具已有的全局缓存；因此结果表示有缓存时的干净安装，不能代表首次联网下载。两边的测试都固定为四个 worker，避免并发设置影响比较。

Daemon 每种运行时启动七次，每次使用新的数据和 Pi 配置目录。从进程创建到 `/health` 返回 200 计算就绪时间；十次 `/projects` 预热后通过 `ps` 读取该 Daemon 进程的 RSS；随后使用同一个 HTTP 连接连续请求 `/projects` 200 次。表中接口 p95 是七次实验各自 p95 的中位数。RSS 是初始化后的进程驻留内存，不是长期稳定内存，也不包含 Electron 或子进程。

桌面包分别生成相同架构的未签名 `.app`，通过 `du -sk` 测占用空间，并以相同 `ditto -c -k --sequesterRsrc --keepParent` 命令压缩后测 ZIP 字节数。ZIP 仅用于比较压缩体积，不是经过签名的发布产物。

## 工具链结果

以下均为三次测量的中位数；变化以 Bun 相对 Node/npm 计算。

| 项目                  | Node 24/npm | Bun 命令（见版本审计） | 耗时变化 |
| --------------------- | ----------: | ---------------------: | -------: |
| 干净安装，有缓存      |     8.032 s |                0.942 s |   −88.3% |
| 类型检查              |     5.998 s |                5.593 s |    −6.8% |
| 完整构建              |     7.940 s |                6.546 s |   −17.6% |
| 完整测试，四个 worker |    15.983 s |               11.301 s |   −29.3% |

安装耗时范围为 npm 7.997–8.164 s、Bun 0.914–1.623 s；构建为 Node 7.923–8.095 s、Bun 6.430–6.605 s；测试为 Node 15.680–17.768 s、Bun 11.247–11.557 s。收益在本机重复测量中保持同一方向。

基线每轮为 1058 项通过；迁移版每轮为 1061 项通过，均无跳过或失败。新增三个用例验证环境文件优先级、真实代理转发与本地绕过，以及新项目 Bun 默认行为。最初的测量副本因为缺少相邻云端仓库而跳过 19 项测试，随后给两边指定同一云端仓库并重新交替测量三轮；此处采用补齐后的完整套件结果。

## Daemon 结果

本机开发运行时对比，七次中位数：

| 项目                   | Node 24.14.1 |  Bun 1.3.11 |   变化 |
| ---------------------- | -----------: | ----------: | -----: |
| 进程启动至健康检查     |   653.121 ms |  505.265 ms | −22.6% |
| 初始化后 RSS           |  211.078 MiB | 259.203 MiB | +22.8% |
| `/projects` 延迟中位数 |    0.0942 ms |   0.0858 ms |  −8.9% |
| `/projects` p95        |    0.1230 ms |   0.1772 ms | +44.1% |
| SIGTERM 至退出         |    35.370 ms |    8.801 ms | −75.1% |

随包 Node 工具链的独立进程参考对比，在另一轮交替实验中测量：

| 项目                   | Node 22.19.0 |  Bun 1.3.11 |   变化 |
| ---------------------- | -----------: | ----------: | -----: |
| 进程启动至健康检查     |   707.976 ms |  521.846 ms | −26.3% |
| 初始化后 RSS           |  178.875 MiB | 259.578 MiB | +45.1% |
| `/projects` 延迟中位数 |    0.0995 ms |   0.0923 ms |  −7.2% |
| `/projects` p95        |    0.1385 ms |   0.2443 ms | +76.4% |
| SIGTERM 至退出         |    18.124 ms |    8.840 ms | −51.2% |

Node 24 的启动范围为 616.867–722.568 ms，Bun 为 473.716–615.456 ms。Node 22 那一轮分别为 683.969–1139.366 ms 和 496.172–572.059 ms。两轮的内存结果方向一致，不能宣称 Bun 在该项目中更省内存。

接口延迟非常小，p95 会受到初始化、GC、日志和本机调度影响；这里的请求返回空项目列表，没有模拟真实项目规模、SSE 或模型流式响应。可确认该轻量接口未表现出明显的绝对耗时优势，不能据此推断真实模型请求会加速。模型和媒体生成主要耗时仍取决于外部服务。

## 包体积

| 项目                   | 原 Node/npm 包 |     Bun 包 |   变化 |
| ---------------------- | -------------: | ---------: | -----: |
| macOS `.app` 占用空间  |     938.40 MiB | 673.16 MiB | −28.3% |
| 相同命令生成的 ZIP     |     335.56 MiB | 238.86 MiB | −28.8% |
| 独立运行时目录占用空间 |     123.47 MiB |  58.25 MiB | −52.8% |

体积收益包含 Bun 的依赖提升与去重布局、ASAR 布局和运行时替换，不应全部归因于 Bun 可执行文件。两个包共用迁移后准备的示例资源，所以这也不是历史发布文件之间的严格逐字节比较。

## 兼容性修复与实际验证

直接强制用 Bun 执行原代码时，测试出现了 18 项失败，Daemon 也无法启动。迁移并非只替换命令：

- Bun 1.3.11 不支持原来的 `process.loadEnvFile`，改为 dotenv 解析，并测试模式优先级与父进程变量保留。
- Undici 全局 dispatcher 无法配置 Bun 的原生 fetch；只修改环境变量还会受 Bun 的缓存影响。改为显式传入代理配置，真实 HTTP 代理及 loopback 请求通过测试。
- 两个 Canvas 测试套件的 ESM 模块替换未能按原方式生效，改在 fetch 边界提供响应，让测试执行真实的渲染器 HTTP 客户端，保留行为断言。
- 百分号编码的长 data URL 动态导入会报 `NameTooLong`，改为 base64；迁移脚本子进程改为直接执行 TypeScript。
- 默认高并发时高亮测试间歇性退化为单色输出。限制为四个 worker 后，完整测试连续三轮通过；保留了检测多种颜色的断言。该结果仍提示 Bun 下的测试兼容性需要持续关注。
- 关闭自动 peer 安装后，干净构建发现 `three` 缺失，将其显式固定到基线使用的 0.172.0。最终 frozen 安装成功，干净安装共 764 个包。
- 外部 Bun 无法读取 Electron 的 ASAR 虚拟文件系统，需解包 Daemon 及依赖；Windows 上直接启动 Bun 可执行文件时去掉不必要的 shell 包装。

已完成的验证：

- frozen 安装、类型检查、完整构建，以及三轮完整测试；最后修正 Pi 默认命令对用户显式配置的保留后，再执行类型检查和完整测试。
- 三个内置示例的准备和构建，以及 macOS ARM64 未签名桌面打包。
- 最终 `.app` 在 PATH 只有 `/usr/bin:/bin` 时启动内置 Bun，渲染器请求项目、模型和示例数据。
- 从最终包的真实文件路径运行 Daemon，使用隔离配置验证鉴权 API、三张示例封面、创建示例项目、安装依赖、启动预览，以及本地生成发布 ZIP。示例构建产物为 6,090,671 字节，没有向外部发布。
- Node 父进程与随包 Bun 子进程通过真实 `ProcessPlaytestDriver` 完成私有 IPC 请求及响应，并验证 Daemon 退出。
- Windows Bun ZIP 下载、SHA-256 校验、解压和 `bun.exe`/`bunx.exe` 准备。此检查在 macOS 上完成，不代表 Windows 应用已运行通过。

未验证 Windows 安装与运行、macOS 签名和公证、自动更新、真实提供商流式会话、OAuth 登录、Godot MCP 实际交互，以及长时间使用时的内存变化。测试和包体验证使用隔离数据目录，未迁移用户现有数据。

## 后续采用建议

开发与 CI 可以优先采用 Bun：本项目安装明显更快，构建和测试也有稳定收益。依赖策略需要明确，不能依赖旧 `node_modules` 或自动补齐 peer dependency。

完整 Daemon 切换值得继续保留为实验。发布前应完成 Windows 和签名包验证，并用真实 Pi 流式会话、预览、媒体任务和持续运行评估内存。若更重视低内存和现有 npm/MCP 的开箱可用性，保留 Node Daemon 的折中方案更合适；若更重视包下载体积和统一 Bun 工具链，可以在补齐这些验证后采用完整迁移。

执行版本审计补充：本次安装、独立 Daemon 和打包内置二进制使用 Bun 1.3.11，但复放原来的 `bun run test` 命令并记录 worker 后，确认 Vitest 子进程使用了全局 Bun 1.4.2。此前将所有工具链测量归为单一 Bun 1.3.11 并声称没有混用版本不准确；原工具链数字应视为当时命令与依赖布局的实验结果。直接以 1.3.11 执行 Vitest 还发现 Fastify 未处理异常，断言通过但退出码为 1。后续工具链版显式执行各个 CLI，统一使用 Bun 1.4.2，重新进行测试和测量。`packageManager` 声明本身不会替换正在执行的 Bun。

测量原始数据收录在 [bun-migration-2026-10-07.json](bun-migration-2026-10-07.json)。本机脚本、原始测试 JSON、日志、基线源码和依赖保留在忽略目录 `.runtime/bun-migration/`；最终包位于 `release/mac-arm64/OhMyGame.app`。

以下复核的是完整实验分支的历史命令；需要先切到 `chore/bun-runtime`，并注意上面的执行版本审计。工具链阶段的验证见 [采用报告](bun-toolchain-2026-10-07.md)。

本地复核命令：

```bash
PATH="$PWD/.runtime/bun:$PATH" bun install --frozen-lockfile
PATH="$PWD/.runtime/bun:$PATH" bun run typecheck
PATH="$PWD/.runtime/bun:$PATH" bun run test
PATH="$PWD/.runtime/bun:$PATH" bun run build:desktop-app
PATH="$PWD/.runtime/bun:$PATH" bunx --bun --no-install electron-builder \
  --mac dir --arm64 --publish never \
  --config.mac.notarize=false --config.mac.identity=null \
  --config.publish.url=https://example.invalid/desktop
node .runtime/bun-migration/smoke-packaged.mjs
```

复跑性能脚本前需要准备与本次相同的基线目录和两边依赖；脚本会重新写入本机测量结果。重复实验时应保持没有其他构建、测试或打包任务并行运行。
