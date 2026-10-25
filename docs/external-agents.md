# External agents (OhMyGame as an MCP server)

Coding agents running outside OhMyGame — Claude Code, Codex, DeepSeek Harness
(`dsh`) and any other MCP client — use OhMyGame's capabilities through one MCP
server, `ohmygame-studio`. This is the reverse of
[coding agents](coding-agents.md), where OhMyGame starts a CLI and offers it
OhMyGame's tools for one conversation.

| Part               | Code                                                                                      | Tests                                       |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| Daemon MCP server  | `src/daemon/external-mcp.ts`                                                              | `test/external-mcp.test.ts`                 |
| Client connections | `src/daemon/external-agent-clients.ts`                                                    | `test/external-agent-clients.test.ts`       |
| Launcher           | `src/desktop/external-mcp-launcher.ts`, `external-mcp-main.ts`, `external-mcp-install.ts` | `test/external-mcp-launcher.test.ts`        |
| Settings           | `src/renderer/external-agents-settings.tsx`                                               | `test/external-agents-settings-ui.test.tsx` |
| Skill              | `integrations/skills/ohmygame-studio/SKILL.md`                                            | Manual                                      |
| Shared contract    | `src/shared/external-mcp.ts`                                                              |                                             |

## Goal and scope

People who already work in a coding agent have chosen and paid for its model.
What they lack is what only OhMyGame has: the media providers configured in
Providers & Models, the Design and Asset Canvas, and the playtest window.
OhMyGame offers exactly those as tools; the external agent plans and writes
the code.

Not in scope, and why:

- **Delegating a task to OhMyGame's own agent.** It nests two agent loops,
  hides progress, and bills two models for one task. It can be added later as
  another tool on the same server.
- **A record of external calls in the app.** Generated files already appear in
  the workspace, the Asset Library and the canvas; a conversation record would
  change the conversation model for little gain.
- **Claude Code and Codex plugin packages.** Connecting from Settings installs
  the server and the Skill; packages would be a second format to maintain.
- **Progress notifications.** Generation jobs (below) already keep every call
  under client timeouts.
- **A user-configured HTTP entry.** It would need a fixed port that can
  collide with other software and a long-lived token in dotfiles, where it
  outlives revocation. Reconsider only for a client that cannot run local
  processes, which also needs remote access design beyond this document.

## Decisions

1. **Three layers, one contract.** The MCP server is the only way to run
   OhMyGame capabilities and is versioned. A Skill teaches the workflow.
   Connecting a client installs both. A Skill alone cannot replace the
   server: the daemon's port and token change with every launch and its HTTP
   API is private.

2. **A fixed public tool list.** External tools are a curated list with
   stable names and schemas. Their handlers are the ones Pi uses
   (`createAgentTools`), run through `ToolBridge`.

3. **stdio for clients.** Claude Code, Codex and `dsh` all run stdio MCP
   servers, and stdio keeps the daemon's port and token out of client
   configuration. The `ohmygame-mcp` launcher speaks stdio to the client and
   HTTP to the daemon.

4. **Off by default, no extra approvals.** Turning the feature on and
   connecting a client is the person's consent. Each client already asks before
   running MCP tools under its own permission settings, and OhMyGame's own
   agent runs these tools without a prompt, so OhMyGame adds no approval step.

5. **Clients are configured with their own commands.** OhMyGame runs
   `claude mcp add` and `codex mcp add` rather than editing their
   configuration files, whose formats change between releases.

6. **A name of its own.** Clients register the server as `ohmygame-studio`,
   not `ohmygame`, which is the name of the server OhMyGame gives the coding
   agents it runs. A CLI that loads both never confuses them.

## Architecture

```text
Claude Code / Codex / dsh
  │ stdio JSON-RPC
  ▼
ohmygame-mcp launcher        answers initialize and tools/list itself
  │ HTTP POST /external-mcp
  │ Authorization: Bearer <token from endpoint.json>
  │ Mcp-Session-Id, X-OhMyGame-Roots
  ▼
Daemon: ExternalMcpService
  ├── sessions: bound project, playtest windows
  ├── public tools → ToolBridge → createAgentTools handlers
  └── generation jobs that outlive the request
```

### Settings and files

Settings → **MCP Server** has its own page, apart from Agents, which sets up
the agents OhMyGame runs. **Allow other agents to use OhMyGame** turns the
feature on; **Connect agents** then lists Claude Code and Codex with
**Connect** and **Disconnect**, and other clients get the launcher command to
configure by hand. See the [MCP Server page](assets/external-agents-settings.webp).
The renderer uses:

| Route                                              | Purpose                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `GET`, `PUT /settings/external-agents`             | `{ enabled }`, the launcher, and client states |
| `PUT /settings/external-agents/clients/:client`    | Connect `claude-code` or `codex`               |
| `DELETE /settings/external-agents/clients/:client` | Disconnect it                                  |

Files in `<dataDirectory>/external-mcp/`:

| File            | Contents                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------- |
| `settings.json` | Whether the feature is on.                                                                    |
| `endpoint.json` | URL, token, contract version and daemon `pid`, POSIX mode `0600`; only while the daemon runs. |
| `tools.json`    | The public tool list and instructions, kept so the launcher works while OhMyGame is closed.   |
| `clients.json`  | Connected clients and the launcher each was connected with.                                   |
| `app.json`      | The desktop app's `pid` while it runs, written before its daemon starts.                      |

- The token is random for each daemon launch and is never stored elsewhere.
  Turning the feature off, or the daemon closing, deletes `endpoint.json`,
  ends every session, and refuses the old token.
- The token only authorizes `/external-mcp`. The daemon's own token never
  leaves the desktop process, as described in the
  [trust boundary](runtime.md#trust-boundary).
- Any process of the same user can read `endpoint.json`. This matches the
  existing local trust model, in which provider credentials are stored in the
  same user's data directory.

### Launcher

- The desktop app writes `<userData>/bin/ohmygame-mcp` at every start. It runs
  `dist/desktop/external-mcp-main.js` from the app archive with the app's own
  executable as Node (`ELECTRON_RUN_AS_NODE=1`), so no Node.js installation is
  needed, and keeps a stable path when the app moves. Windows clients start
  the executable directly with that variable, because Node no longer runs
  `.cmd` files without a shell; the installer keeps the executable's path
  across updates. At startup, clients connected with a different launcher are
  connected again and their Skill is updated.
- It answers `initialize` and `tools/list` from `tools.json`. Clients start
  every configured MCP server when a session opens, in any folder, so the app
  must not start just because a client did.
- The first tool call starts OhMyGame if `endpoint.json` is missing or its
  `pid` is gone, and waits up to 30 seconds. An app whose `app.json` process
  is alive is starting or restarting its daemon, so the launcher only waits:
  the app has no single-instance lock, and a second copy would run a second
  daemon on the same data. If the feature is off, the call instead explains
  where to turn it on.
- It sends the client's MCP roots in `X-OhMyGame-Roots`, or, for clients
  without roots, `CLAUDE_PROJECT_DIR` and its working directory. A restarted
  daemon or an expired session is reconnected once. An explicit `open_project`
  selection is remembered by its returned project ID and restored before any
  project tool runs in a replacement session. If that project is gone, the
  tool fails until the client selects another project; it never falls back
  to the working folder silently. Closing stdin ends the daemon session.
- A 401 or 404 rejects a call before execution, so it can be retried after
  reconnecting. After a lost or unreadable response, only read-only tools are
  retried. Generation, edits, playtesting and other mutating calls report that
  execution status is unknown; check the project before starting them again.
  This prevents a lost response from creating a second paid generation.

### Inside OhMyGame

A person who connected Claude Code or Codex may also run them inside OhMyGame
with their own configuration. They already have OhMyGame's tools there, so
the external server is kept out three ways:

- Claude Code gets `--disallowedTools mcp__ohmygame-studio` when it uses the
  person's configuration; isolated sessions load no user servers at all.
- Codex gets `mcp_servers.ohmygame-studio.enabled = false` when the person's
  configuration has it.
- Every CLI OhMyGame runs has `OHMYGAME_EXTERNAL_MCP_DISABLED=1`, and the
  launcher refuses to start with it.

### The daemon endpoint

`POST /external-mcp` takes MCP JSON-RPC messages in the Streamable HTTP style
and answers with JSON; nothing is streamed, so `GET` returns 405.

- `initialize` creates a session and returns it in `Mcp-Session-Id`. Later
  requests without the header get 400; an unknown or expired session gets 404,
  telling the client to initialize again. `DELETE` ends a session. Sessions
  idle for six hours end.
- `X-OhMyGame-Roots` carries a JSON array of absolute paths or `file:` URLs.
  The first one inside a project's workspace binds the session to that
  project until `open_project` chooses one explicitly.
- `instructions` in the `initialize` result give a short usage guide, so
  clients without the Skill still know about projects and jobs.

## Public tools

Every session lists the same tools, whichever project it uses. A tool the
bound project does not have returns an error that says why.

| Tool                                                                        | Notes                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list_projects`, `open_project`, `get_project`                              | Project ID, name, type and workspace folder; `open_project` by ID or folder |
| `get_job`, `wait_job`, `cancel_job`                                         | Generation jobs, see below                                                  |
| `generate_image`, `generate_video`, `generate_3d_asset`, `animate_3d_asset` | Run as jobs                                                                 |
| `generate_speech`, `generate_sound_effect`, `generate_music`, `generate_audio`                | Run as jobs                                                                 |
| `canvas_check`, `canvas_initialize`, `generate_canvas_media`                | `generate_canvas_media` runs as a job                                       |
| `game_use`                                                                  | Needs the desktop app and a project with a game preview; opens a window     |
| `playable_add_node`, `playable_check`                                       | Interactive Story projects only                                             |

`game_use` lists the full web game input; a story project's own tool accepts
the subset its player supports.

Not offered: Pi's file and shell tools (`read`, `write`, `edit`, `bash`,
`grep`, `find`, `ls`, `recall_image`), which the client has; `questionnaire`
and `update_plan`, since the client asks and plans itself; `install_plugin`,
`web_search`, and the plugin `mcp` passthrough.

Generated files are saved in the project workspace and its Asset Library.
Results name each file's workspace-relative path; the agent reads it with its
own tools. Files the agent edits with its own tools bypass OhMyGame
checkpoints and cannot be undone from the app. A session's playtest windows
close when the session ends, changes project, or its project is deleted.

### Versioning

- `serverInfo.version` and `contractVersion` are the contract version (`1`).
- Adding tools or optional parameters is compatible. Renaming, removing, or
  changing the meaning of a tool or parameter is not: add a new name and keep
  the old one, marked deprecated in its description, for at least two
  releases.
- `test/external-mcp.test.ts` asserts the listed tool names, so a change to
  the public list fails until it is made deliberately. Update the Skill with
  it.

### Generation jobs

Video, 3D and music often take minutes, and Codex's default MCP tool timeout
is 60 seconds.

- A generation tool waits up to 45 seconds. If it has finished, it returns
  the result; otherwise it returns a job ID and tells the agent to call
  `wait_job`.
- `wait_job` waits up to 45 seconds (`timeoutSeconds` shortens it) and follows
  the same rule; `get_job` answers at once.
- Jobs belong to the daemon, not the session. A disconnected client does not
  stop a generation a provider may already be charging for; another session
  can collect its result. Only `cancel_job` stops it. Finished jobs are kept
  for six hours, and all jobs end when OhMyGame closes.
- Quick tools, such as `canvas_check` and `game_use`, run in the request and
  stop if the client disconnects.

## Clients

| Client      | Connected by                                  | Skill folder                                         |
| ----------- | --------------------------------------------- | ---------------------------------------------------- |
| Claude Code | `claude mcp add --scope user ohmygame-studio` | `$CLAUDE_CONFIG_DIR/skills`, else `~/.claude/skills` |
| Codex       | `codex mcp add ohmygame-studio`               | `~/.agents/skills`                                   |
| dsh, others | Hand configuration with the command shown     | `~/.agents/skills` for `dsh`, copied by hand         |

OhMyGame copies the Skill only into a missing folder or one it wrote, and
removes it on disconnect unless another connected client reads the same
folder. Existing folders without `SKILL.md` and symlinked folders are left alone.

For `dsh`, add a `@deepseek-ai/dsh-mcp-client` entry to the profile's
`cordis.patch.yml`, where `<launcher>` is the command shown in Settings:

```yaml
- insert:
    - id: mcp-ohmygame-studio
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: ohmygame-studio
        transport: stdio
        command: "<launcher>"
```

## Validation

Automated tests cover the contract, sessions, project binding, jobs, token
revocation, the launcher against the service, the launcher script, client
commands and Skill installation, the Settings flow, and the guards inside
OhMyGame. The packaged app check (`scripts/check-packaged-desktop.mjs`) runs
the launcher from the app archive with the app's executable and checks the
Skill is shipped.

Manual acceptance for each client: connect from Settings, open a project
folder in the client, generate an image and a 3D model through `wait_job`,
playtest with `game_use`, then disconnect and confirm the entry and Skill are
gone.
