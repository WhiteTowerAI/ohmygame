# Beta Plugin 手动验收

本清单用于亲自验证 Cocos Creator、微信小游戏、抖音小游戏、Unity、Unreal
Engine、Aseprite、Tiled 的真实工作流。7 个插件均默认关闭，卡片显示 Beta。
包结构、自动测试或 MCP 连接通过，均不代表下面的真实闭环已经通过。
本轮交付时，这 7 项真实闭环均待人工验收。

## 开始前

1. 使用包含这些插件的开发版本。已安装的旧版 App 不会读取 Git 目录里的新插件。
   在该分支的仓库目录，按 [贡献指南](../CONTRIBUTING.md#start-local-development)
   准备 Node.js 22.19+、Bun 1.4.2+，执行 `bun install --frozen-lockfile`，再运行
   `bun run dev:desktop`。为游戏对话连接一个可用语言模型。
2. 在首页左侧的 Plugins（插件）确认 7 张卡片均有 Beta 标签、初始为关闭。
   每轮只打开要测的插件；重启后应保留你的开关选择。
   Aseprite、Tiled 可用于 General、Web Game、Godot、Asset Canvas；其余 5 个
   本轮用于 General。使用已有项目时，关联源码目录，而不是生成的发布目录。
3. 使用可丢弃的测试项目或有版本备份的副本，记录工具的完整版本号。
   引擎/小游戏项目使用 General 并关闭 Web 预览；Web 导出完成后再按需配置浏览器预览。
   插件不会安装引擎、激活许可证或代替你登录平台。
4. 在对话里明确当前项目的绝对路径。下文提示词保持英文，可直接复制。
   没有相关工具或账号时，记录“未测”及缺少的前置条件。

共同检查：对话应识别正确项目；不得自行升级引擎、改其他 AI 编辑器配置，或将
“本地构建/预览”变成上传、提审、正式发布。源文件和产物位置应明确，失败时应
提供真实日志和下一步，而不是凭进程启动就报告成功。

## 1. Cocos Creator

**准备：** 安装一个 Creator 3.8 LTS 版本，用它创建或打开一个简单 2D 测试项目。
启用 Cocos Creator。首轮先测 Web，随后用同一份源码测微信和抖音。

**发送：**

```text
Use this Cocos Creator project and its matching installed editor. Add a visible
tap counter with a reset button to a test scene. Save the scene, build a Web
preview with Creator's own build tools, and report the editor version, build
configuration, output directory, and actual diagnostics. Do not upload anything.
```

**亲自操作：** 在 Creator 打开该场景；运行后点击 3 次、重置，再点击 1 次。
打开生成的 Web 版本重复同样的操作；关闭并重开源码场景。

**通过标准：** 编辑器和 Web 产物都依次显示 3、0、1；无相关编译/运行错误；
场景和组件引用重开后仍在；构建确实使用匹配的 Creator，而非另一个 `cocos-cli`。
保留构建日志、产物路径和运行截图。

## 2. 微信小游戏

**准备：** 上述 Cocos 项目，微信开发者工具、可访问的小游戏 AppID，以及可扫码预览的
微信设备。普通微信聊天 App 不能代替开发者工具。同时启用 Cocos Creator、微信小游戏。

**发送：**

```text
Export this Cocos game for WeChat Mini Games using the existing platform
integration. Preserve the source project and AppID. Check the generated game
directory and prepare a WeChat DevTools preview. Add local persistence for the
tap count and provide simulator and device checks. Do not upload a test version,
submit for review, or publish.
```

**亲自操作：** 将生成目录导入微信开发者工具，确认 AppID、运行目标与控制台；
点击计数、退出并重进，确认计数恢复。扫码到手机，重复点击、重置、退出重进，
切后台再回前台。记录机型、系统和微信版本。若游戏用到音频/联网，单独验证这些流程。

**通过标准：** 模拟器和真机均正常运行，触摸、存储恢复与重置正确；没有通过关闭
域名/基础库检查来掩盖真机故障；未自行上传、提审或发布。仅有 Web 截图不能算通过。

**可选上传验收：** 另发明确指令，指定 AppID、版本号、描述和产物目录，要求只上传
测试版本；在平台后台确认该版本。保存返回结果，不需要进行审核或正式发布。

## 3. 抖音小游戏

**准备：** 同一个 Cocos 源项目，官方抖音游戏开发者工具、可访问的游戏 AppID 和
可预览的抖音设备。同时启用 Cocos Creator、抖音小游戏。

**发送：**

```text
Export this Cocos game for Douyin Mini Games using the matching engine adapter.
Keep the WeChat output separate. Check game.json, project.config.json, resource
paths, and the AppID, then prepare a developer-tool and device preview. Preserve
the tap counter, reset, and local persistence. Do not upload a test version,
submit for review, or publish.
```

**亲自操作：** 导入抖音构建目录，在开发者工具与真机上重复微信验收中的计数、重置、
重进和前后台操作；查看日志，确认源项目和微信产物没有被改成抖音配置。

**通过标准：** 模拟器和真机行为正确，平台适配与构建目录独立；没有把微信适配器
或普通 Web 构建当成抖音成品；CLI 如被使用，应是匹配的小游戏工具。未执行未请求的
测试上传、提审或发布。上传可另行明确授权并在后台核对测试版本。

## 4. Unity

**准备：** 安装并激活 Unity 6.0 LTS 或更高版本，用对应 Editor 创建一个测试项目。
安装官方 Unity CLI；在需要编辑器联动时按官方步骤接入 Pipeline 包。启用 Unity。
记录 Editor、CLI、Pipeline 的版本。旧项目不应因测试被自动升级。

**发送：**

```text
Check this Unity project's version and official CLI/Pipeline connection. Verify
the absolute project path before changing anything. In a new test scene, create
a named cube that rotates over time and resets its rotation when I press R.
Save the scene, check C# compilation, run it in Play Mode, and report the actual
runtime evidence. Keep existing scenes and other Editor projects unchanged.
```

**亲自操作：** 在 Editor 打开保存的测试场景，运行并确认立方体持续转动，按 R 后复位；
停止后重开场景再次运行。检查 Console。可再打开另一测试项目，要求只检查当前项目身份，
确认 Agent 不会默认选择第一个 Editor。

**通过标准：** 操作目标正确；C# 无相关编译错误；旋转随时间推进、输入有效；场景保存
后能重开；`.meta` 与资源引用完好。CLI 能连接或 `isPlaying=true` 不单独构成通过。
若缺少许可证/CLI/Pipeline，应明确指出，不应自动换引擎或安装第三方桥接。

**构建验收：** 再要求对这个测试场景构建一个已安装支持模块的本地目标，提供构建日志
和产物路径；亲自启动产物，重复旋转和 R 复位检查。发布到平台不在此项验收范围内。

## 5. Unreal Engine

**准备：** 使用实际包含官方实验性 Unreal MCP 的 Editor 构建（当前官方文档为 UE 5.8），
建立测试项目，启用 Model Context Protocol 及所需场景/Actor 工具集。若当前版本根本
没有该插件，记为“前置条件不满足”，不要自动升级或装社区桥接。

在该 Editor 控制台执行 `ModelContextProtocol.StartServer`，在 OhMyGame 插件中把
Local Unreal MCP URL 配成对应的 loopback 地址，默认 `http://127.0.0.1:8000/mcp`。
启用 Unreal Engine，测试连接。默认只发现 3 个工具是工具搜索模式，仍需做真实调用。

**发送：**

```text
Using serial Unreal MCP calls, inspect the connected project, current level,
and available toolsets without editing. After confirming the target, create a
new test level with a cube actor named OMG_BetaCube at a clearly reported
transform. Save it, read the actor back, and report its saved asset path. Use
only operations exposed by this Editor. Do not modify existing levels.
```

**亲自操作：** 检查项目、关卡、Actor 名称和 Transform；关闭并重开测试关卡，确认保存。
如果实际工具集支持视口截图，要求截图并核对；对行为修改，另跑 Play-in-Editor 并查看日志。

**通过标准：** 至少一次只读业务调用和一次保存后的修改验证成功；调用串行执行；项目
与关卡正确；重开后 Actor 存在。工具握手不能替代这些检查，缺失的蓝图/截图/输入能力
应被明确说明。结束按需执行 `ModelContextProtocol.StopServer`。

## 6. Aseprite

**准备：** 安装 Aseprite，确认实际可执行文件路径。在一个已有精灵加载方式的 Web/Godot
测试项目中启用 Aseprite；Asset Canvas 可以测文件交付，但运行时集成仍需引擎项目。

**发送：**

```text
Create an editable 16x16 pixel-art sprite in Aseprite with four animation frames
and an idle tag. Export a PNG sheet and JSON metadata compatible with this
project's loader, preserving frame durations. Keep the editable source, inspect
the export, and integrate a looping animation into a test scene. Use a separate
output directory so existing art is preserved.
```

**亲自操作：** 在 Aseprite 打开源文件，确认 4 帧、图层、idle 标签与帧时长；检查 PNG
透明度和 JSON 帧矩形。运行游戏，确认动画、速度、锚点和缩放效果。要求再次导出，
核对源文件没有因导出被覆盖。

**通过标准：** 可编辑源、PNG、JSON 均存在且互相对应；无越界帧、标签丢失或白底；
游戏实际加载导出资源并播放。只有生成一张图片或写出一份 JSON 不算通过。

## 7. Tiled

**准备：** 安装 Tiled，在支持 Tiled 导入或已明确可实现导入的游戏项目启用 Tiled。
准备一个测试 tileset 图片，最好包含可辨认方向的图块，便于检查翻转。

**发送：**

```text
Create a small editable Tiled level using this project's supported map format.
Include a player spawn, solid collision, a reachable goal, and one flipped tile.
Keep the tileset external with relative image paths. Export a runtime map into
a separate directory, integrate it with the actual loader, and explain how to
verify collision and reaching the goal.
```

**亲自操作：** 在 Tiled 打开源码地图，检查图块、对象层和属性；在游戏中确认出生点，
撞墙不能穿过，走到终点触发目标行为，方向图块翻转正确。关闭并重开地图。
复制交付目录到另一位置后，再打开地图/运行加载，检查相对路径是否可用。

**通过标准：** 源地图、外部 tileset、图片和导出地图齐全；没有机器绝对路径或缺失引用；
碰撞与目标事件来自实际地图数据；保存重开与移动目录后仍正常。对引擎不支持的格式特性，
应明确给出限制或受控转换，不能静默丢失。

## 记录结果

每项保留一份记录，失败时连同对话工具日志反馈；隐藏账号、密钥等敏感信息。

```text
Plugin / OhMyGame branch or commit:
OS / engine / tool / SDK versions:
Project type / source path / output path:
Result: PASS / FAIL / NOT RUN
Verified: source edit / save-reopen / build / runtime / device / optional upload
Evidence: log paths, screenshots, artifact paths, platform result if applicable
Failure: exact error, reproduction steps, expected versus observed behavior
```

建议顺序：Cocos Web → 微信 → 抖音 → Aseprite → Tiled → Unity → UE。
微信/抖音的上传是额外账号能力检查，审核和正式发行由你另行决定。

## TapTap Maker 接入与原生预览

需要 Git、Python 3.8+（含 venv/pip）和 Maker 账号。

1. 在插件页启用 Maker，点击「准备环境」并完成「连接账号」。应通过官方浏览器授权，不能要求在对话中提供 token，也不能修改 Codex/Cursor/Claude 配置。
2. 首页引用 Maker，确认类型切换为 General。填写需求并创建，应保留原输入框，并弹出带 Maker 图标和名称的创建窗口；默认「新建项目」，账号已就绪时只显示一行摘要，其他操作收进「账号选项」。填写名称后点击「创建 TapTap Maker 项目并开始」；成功后才进入会话，不应在首次发送会话时弹出接入窗口。也应能切换「已有项目」并明确选择项目。关闭或按 Escape 后需求和附件应保留，焦点回到创建入口；创建时应显示进度，失败时保留名称并允许继续。插件页「新建项目」和普通新建窗口的「项目插件」应使用同一流程。
   创建成功后模拟本地拉取失败，重试必须继续初始化同一个 Maker 项目；结果未知时应检查项目列表，不能直接再创建一次。
3. 新导入一个已经绑定的 Maker 目录，应识别为插件项目，保留原绑定。重新导入一个已登记为 OhMyGame 项目的目录，项目应保持原样。已有 Web 项目的 @ 菜单中不应出现 Maker。
4. 在一个已有的 General 项目中引用 Maker 并发送：应打开连接面板并说明会关闭 Web 预览和社区发布。直接关闭面板，项目设置和 Web 预览应保持不变；再次发送并点击「继续」后才切换为 Maker 项目。
5. 在预览标签页安装 Runtime、启动、刷新、查看日志、停止。游戏在独立原生窗口中运行，不能出现 Web iframe 或 Web Play 按钮。刷新会重启游戏。
6. 关闭并重开项目，检查绑定仍在；离开预览标签页后不得继续轮询预览状态。准备过程取消或失败后应能显式重试；在插件页授权进行中时打开项目连接面板，应显示授权进度而不是报错。
7. 预览运行时点击「断开插件」并确认：原生窗口应停止，项目恢复为普通 General（Web 预览保持关闭），工作目录中的 `.maker-mcp` 绑定文件保留；再次引用 Maker 可重新连接，且不重新初始化。禁用 Maker 插件后仍应能断开。
8. 实际运行和检查一个 Lua 改动；远端 build/提交只在你明确要求时执行，检查提交、推送和构建各阶段结果，再去 Maker 发布页完成发布。

**通过标准：** 完成「启用 → 创建阶段的环境与授权 → 新建或连接已有项目 → 会话开发 → 原生预览 → 断开/重连」闭环；已有绑定不会被替换，已有项目只在点击「继续」后切换。CLI 0.0.36 不支持 `preview validate` 或原生截图，不能以进程存活代替游戏验证。
