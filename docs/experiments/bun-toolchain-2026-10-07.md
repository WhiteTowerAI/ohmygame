# Bun 工具链采用与桌面运行时对比（2026-10-07）

`chore/bun-toolchain` 从原基线 `eb56e5d942180980122b8b94cf159d679c89cbd9` 建立，采用 Bun 1.4.2 安装和执行工具链，应用 Daemon 继续使用 Node。完整迁移保留在 `chore/bun-runtime`，提交 `d873411`。本报告初次完成时两个分支均只有本地提交；创建工具链 PR 前的同步与验证见文末补充。

建议采用工具链版。缓存干净安装约快 88%，完整测试约快 25%，构建约快 11%；桌面包仍附带 Node/npm，既有工作区和 MCP 命令继续开箱可用。实际桌面 Daemon 的初始化内存和接口延迟接近原包，完整 Bun 运行时仍需要单独评估。

## 采用范围

- 根项目以 `bun.lock` 为唯一安装锁，删除根 `package-lock.json`；CI 和发布构建固定 Bun 1.4.2，并安装 Node 22.19.0。
- TypeScript、Vite、Vitest、Electron CLI、electron-builder 和准备脚本由 Bun 执行。保留原构建器和测试框架，用直接 JS 入口与 `--bun` 明确选择执行版本。
- 固定 SHA-256 的预装 Plugin ZIP 使用 Node/tsx 准备，以复现既有归档字节；CI 执行该准备步骤，检查没有历史缓存时也能生成匹配的归档。
- `bunfig.toml` 关闭自动 dotenv、自动 peer 安装和全局 Node 替换。补充 `model-viewer` 需要的 `three` 0.172.0，保留 `tsx` 4.20.5 供 Node 开发使用。
- `bun run dev:daemon` 使用 `node --import tsx --watch`，`bun run start` 使用 `node`。Electron 仍以自身可执行文件和 `ELECTRON_RUN_AS_NODE=1` 启动 ASAR 内的 Daemon。
- 桌面包保留经过校验的 Node 22.19.0/npm 10.9.3。新工作区默认 npm，已有包管理器选择、锁文件、Pi 命令和 `npx` MCP 配置继续有效；内置示例保留 npm 锁文件，并继续用 npm 准备和构建。
- 原 Daemon 环境加载和 Undici 代理实现保持原逻辑。运行时准备脚本在 Bun 下改用显式 dotenv 解析，统一生产模式文件优先级并保留父进程变量。
- Canvas 测试改为在 HTTP 边界提供响应，动态 ESM 测试使用临时模块文件；保留行为断言。Vitest 限制四个 worker，避免高亮初始化在高并发下退化。
- 增加实际 Node 启动与鉴权 API 检查，纳入 CI；桌面 Pi 目录支持环境变量覆盖，便于隔离验证。

## 工具链测量

Apple M4、24 GiB 内存、macOS 15.6.1 ARM64；原工具链为 Node 24.14.1/npm 11.11.0，采用版为 Bun 1.4.2。每项交替执行三轮，运行时没有其他构建、测试或打包任务。安装在新目录进行，两边保留已有下载缓存；这不是首次联网安装测试。

原代码与依赖保留在独立基线目录，采用版复制当前源代码并使用 Bun 安装的依赖。构建去除本地环境配置，两边测试固定四个 worker，使用同一 `ohmygame-cloud` 修订 `cd580f5654e37810dddc63642c1f54b17c3255b0` 执行发布契约测试。检查命令退出码及日志，不能只凭 Vitest JSON 的 `success` 字段判定通过。

三轮中位数：

| 项目         | 原 Node/npm | Bun 1.4.2 | 耗时变化 |
| ------------ | ----------: | --------: | -------: |
| 缓存干净安装 |     8.278 s |   0.976 s |   −88.2% |
| 类型检查     |     5.747 s |   5.207 s |    −9.4% |
| 完整构建     |     7.799 s |   6.980 s |   −10.5% |
| 完整测试     |    16.818 s |  12.552 s |   −25.4% |

原版每轮 1058 项通过；采用版每轮 1059 项通过，新增环境文件优先级用例，无跳过、失败或未处理异常，CLI 退出码均为 0。安装为 npm 7.887–13.210 s、Bun 0.932–1.602 s；测试为原版 15.860–18.403 s、采用版 11.976–12.729 s。类型检查的范围有重叠（Node 5.320–6.015 s、Bun 4.695–6.713 s），其收益不应视为稳定保证。

## 实际桌面 Daemon 测量

旧报告中的独立 Node 22 数据代表随包工作区工具，并不代表桌面 Daemon。原桌面 Daemon 实际运行于 Electron 内置 Node 24.18.1。本次用三个生成的 `.app` 的真实可执行文件和 Daemon 入口重新比较：原 npm 包、工具链版包均使用 Electron Node 模式和 ASAR 入口；完整 Bun 实验包使用随包 Bun 1.3.11 和解包入口。

每种包启动七次，轮换顺序、隔离数据和 Pi 配置。测量进程创建至 `/health` 返回 200，十次 `/projects` 预热后的进程 RSS，再通过持久 HTTP 连接请求空项目列表 200 次。结果为七轮中位数；p95 列是每轮 p95 的中位数。

| 项目                   | 原桌面 Node 24.18.1 | 工具链版 Node 24.18.1 | 完整 Bun 1.3.11 |
| ---------------------- | ------------------: | --------------------: | --------------: |
| 就绪时间               |          825.680 ms |            804.090 ms |      468.675 ms |
| 初始化 RSS             |         226.859 MiB |           217.281 MiB |     255.031 MiB |
| `/projects` 延迟中位数 |           0.1002 ms |             0.0991 ms |       0.0944 ms |
| `/projects` p95        |           0.1303 ms |             0.1268 ms |       0.1828 ms |
| SIGTERM 至退出         |           18.828 ms |             18.840 ms |        8.826 ms |

工具链版没有引入 Daemon 内存增长：RSS 中位数低约 9.6 MiB（4.2%），就绪时间差约 22 ms。依赖布局及加载差异也参与其中，不能推广为长期使用时的收益。

完整 Bun 包相对原桌面包就绪快约 357 ms（43.2%），初始化 RSS 多约 28.2 MiB（12.4%），轻量接口 p95 多约 0.053 ms。前一报告的 Node 22 对比中 +45.1% RSS 并非桌面迁移增幅；现在用真实桌面执行方式替换该结论。

这些是 Daemon 单进程数据，未启动父 UI 和私有 IPC 来测性能，不包含整个 Electron 应用或子进程内存。空列表接口的亚毫秒差异不能推断真实模型、媒体任务、SSE 或大型项目表现。

## 本地桌面包

三个包都是 macOS ARM64 未签名 `.app`。用相同 `ditto -c -k --sequesterRsrc --keepParent` 压缩，原包和完整 Bun 包复用前一实验的同一产物测量：

| 项目               |  原 npm 包 |   工具链版 | 完整 Bun 包 |
| ------------------ | ---------: | ---------: | ----------: |
| ZIP                | 335.56 MiB | 240.04 MiB |  238.86 MiB |
| 独立运行时目录占用 | 123.47 MiB | 123.47 MiB |   58.25 MiB |

工具链版 ZIP 减少约 28.5%，比完整 Bun 包大约 1.2 MiB。依赖提升、去重和 ASAR 布局也会影响结果，所以包体积收益不能全部归于运行时大小。本轮工具链版使用原 npm 示例资源，前一实验的两个包使用相同的 Bun 示例资源；这不是历史签名发布文件的逐字节比较。文件系统实际分配空间会随 APFS 压缩等因素变化，原始 JSON 同时记录本轮磁盘测量与文件字节数。

## 已完成的验证

- frozen 安装、类型检查、三轮完整测试、桌面全量构建、macOS ARM64 未签名打包。
- Node 22.19.0 执行 `test:node-runtime`：真实 Daemon 管理器启动、未授权访问 401、授权健康检查和项目 API 200、退出及临时数据清理。
- `bun run dev:daemon` 在 Node 22.19.0 路径下启动；记录实际进程版本，确认没有被替换成 Bun，授权健康检查通过。
- 修正 concurrently 10.0.4 的直接 CLI 入口为 `dist/bin/index.js`。完整 `bun dev:desktop` 在隔离配置和 Chromium profile 下启动 Vite、Electron 与 Daemon，渲染器项目、模型和示例请求均为 200；`bun dev` 的 Vite 首页和隔离端口 Node Daemon 健康检查也均为 200。最初只验证桌面包和单独 Daemon，漏跑完整开发桌面命令，因而没有发现错误入口。
- 最终桌面包在 PATH 只有 `/usr/bin:/bin` 的环境下隔离启动；渲染器 `/projects`、`/models`、`/examples` 均返回 200，Daemon 使用包内 Electron 可执行文件和 ASAR 入口。
- 使用包内 Electron Node 父/子进程完成真实 `ProcessPlaytestDriver` 私有 IPC 往返，验证健康检查、项目、模型、三个示例与封面 API。
- 仅使用随包 Node/npm 创建 Circuit Craftsman 示例、安装依赖、启动预览并构建本地发布 ZIP（6,090,686 字节）。没有向外部发布，没有使用系统 Node 或 Bun。

本轮没有执行远端 CI，也没有验证 Windows 安装运行、签名公证、自动更新、真实提供商流式会话、OAuth、Godot MCP 实际交互或长时间内存表现。Windows 发布工作流已迁移命令，仍应由实际 Windows 运行验证。

## 版本审计与后续选择

完整实验此前用 Bun 1.3.11 启动器，但复放原测试命令并记录 worker 后发现实际执行的是全局 Bun 1.4.2。直接以 Bun 1.3.11 执行 Vitest 时出现 Fastify `ERR_HTTP_HEADERS_SENT` 未处理异常，即使断言全部通过也会退出 1；原工具链测量只能视作当时命令和依赖布局的历史结果。

本分支统一使用已验证的 Bun 1.4.2，以直接 CLI 入口避免 shebang 隐式选择其他运行时。`packageManager` 不会自动安装或切换实际执行版本；升级 Bun 时应重新跑完整套件和 Node 检查。桌面完整 Bun 实验包仍内置 1.3.11，其直接 Daemon 测量与这个测试 worker 版本问题分开记录。

工具链收益足以支持当前采用。完整 Daemon 迁移有更快启动的价值，但需补齐新版 Bun 的桌面、Windows、真实会话和内存验证，且仍有移除随包 Node/npm 后的现有工作区兼容成本。

可审阅数据：[bun-toolchain-2026-10-07.json](bun-toolchain-2026-10-07.json)。本机对比脚本、逐轮日志和测试报告保留在忽略目录 `.runtime/bun-migration/`；采用版包在 `release/toolchain/mac-arm64/OhMyGame.app`，完整实验包在 `release/mac-arm64/OhMyGame.app`。

日常验证：

```bash
bun --version # 本轮为 1.4.2
bun install --frozen-lockfile
bun run prepare:preinstalled-plugins
bun run typecheck
bun run test
bun run test:node-runtime
bun run build:desktop-app
```

完整云端契约测试需要安装同一相邻云端仓库，或设置 `OHMYGAME_CLOUD_ROOT` 指向它。性能复核需要原基线与两种依赖布局，并避免并行构建测试；单次执行上述命令不等同于交替三轮基准。

## 创建 PR 前的补充验证

分支同步到 `main` 的 `f1c63ee` 后，在独立 worktree 使用全新 Bun 安装复核。新加入的聊天时间线测试需要先以实际模块路径注册 `vi.doMock`，再动态导入时间线，避免 Bun 下静态 ESM mock 未生效；原有 72 项行为断言保持有效，分别在 Bun 1.4.2 和 Node 22.19.0 下通过。最新完整套件为 1101 项通过、无跳过；类型检查、空缓存预装插件准备、三个示例准备、桌面全量构建和 Node 22.19.0 Daemon 启动鉴权检查均通过。前面的性能数字仍对应原基线与三轮 1059 项套件，未重新测量最新主线性能。

无历史 Plugin 缓存时，Bun 1.4.2 生成的 ZIP SHA-256 为 `c6e52698406975e7c319c8554dc05d80e14b4584367f6b19d3419e4f25725516`，与锁定归档不一致；Node 22.19.0 成功复现锁定值 `e3b5d2bb9e5e4b6b0afd1b2e3ba1da6ff9334b6e584bda0cd59978a88a734d93`。此前复用已准备资源的构建没有覆盖这一差异。因此预装 Plugin 准备明确保留 Node，并新增 CI 准备检查，不修改固定校验值。

首轮 GitHub Ubuntu CI 通过安装、Plugin 归档校验和类型检查，测试发现两处文件列表断言依赖目录枚举顺序，另有高亮样例在 Shiki 默认 500 ms 单行分词预算下返回部分着色。文件列表断言改为排序后比较全部文件名；固定短代码样例在测试 mock 中关闭分词预算，保留重试、多颜色和转义断言，应用渲染器仍使用原来的 500 ms 预算。CI 没有相邻云端仓库，会按既有逻辑跳过 19 项云端契约测试；本地提供该仓库的完整套件不跳过。
