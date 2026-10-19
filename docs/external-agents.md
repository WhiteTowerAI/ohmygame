# External agents (OhMyGame as an MCP server)

Status: in progress. Milestone 1 (the daemon's MCP server) is implemented in
`src/daemon/external-mcp.ts`; the launcher, Settings UI, and client packages
are not, so the feature has no user-facing entry yet.

Coding agents running outside OhMyGame — Claude Code, Codex, DeepSeek Harness
(`dsh`) and any other MCP client — call OhMyGame's capabilities through one
MCP server. This is the reverse of [coding agents](coding-agents.md), where
OhMyGame starts a CLI and offers it OhMyGame's tools for one conversation.

## Goal and scope

People who already work in a coding agent have chosen and paid for its model.
What they lack is what only OhMyGame has: the media providers configured in
Providers & Models, the Design and Asset Canvas, and the playtest window.
OhMyGame offers exactly those as tools; the external agent plans and writes
the code.

Delegating a whole task to OhMyGame's own agent is out of scope: it nests two
agent loops, hides progress, and bills two models for one task. It can be
added later as another tool on the same server without changing this design.

## Decisions

1. **Three layers, one contract.**

   | Layer          | Role                                                  | Where                               |
   | -------------- | ----------------------------------------------------- | ----------------------------------- |
   | MCP server     | The only way to run OhMyGame capabilities. Versioned. | The daemon                          |
   | Skill          | When and in what order to use the tools.              | `integrations/agent-plugin/skills/` |
   | Client package | Installs the MCP entry and the Skill into one client. | Thin, per client                    |

   A Skill alone cannot replace the server: the daemon's port and token change
   with every launch and its HTTP API is private. A client package is only
   packaging; clients without a package format (such as `dsh`) get the MCP
   entry and the Skill written directly.

2. **A fixed public tool list.** External tools are a curated list with
   stable names and schemas. Their handlers are the ones Pi uses
   (`createAgentTools`), run through `ToolBridge`.

3. **stdio for clients.** Claude Code, Codex and `dsh` all run stdio MCP
   servers, and stdio keeps the daemon's port and token out of client
   configuration. A small launcher speaks stdio to the client and HTTP to the
   daemon.

4. **Off by default, no extra approvals.** Turning the feature on and
   connecting a client is the person's consent. Each client already asks before
   running MCP tools under its own permission settings, and OhMyGame's own
   agent runs these tools without a prompt, so OhMyGame adds no approval step.

5. **No user-configured HTTP entry.** It would need a fixed port that can
   collide with other software and a long-lived token copied into dotfiles,
   where it outlives revocation. Reconsider only for a client that cannot run
   local processes, which also needs remote access design beyond this one.

## Architecture

```text
Claude Code / Codex / dsh
  │ stdio JSON-RPC
  ▼
ohmygame-mcp launcher        (milestone 2)
  │ HTTP POST /external-mcp
  │ Authorization: Bearer <token from endpoint.json>
  │ Mcp-Session-Id, X-OhMyGame-Roots
  ▼
Daemon: ExternalMcpService
  ├── sessions: bound project, playtest windows
  ├── public tools → ToolBridge → createAgentTools handlers
  └── generation jobs that outlive the request
```

### Enabling and the endpoint file

`GET` and `PUT /settings/external-agents` read and set `{ "enabled": boolean }`
with the app's token; the choice is kept in
`<dataDirectory>/external-mcp/settings.json`.

While the feature is on and the daemon is listening, it writes
`<dataDirectory>/external-mcp/endpoint.json` (mode `0600`):

```json
{
  "version": 1,
  "url": "http://127.0.0.1:<port>/external-mcp",
  "token": "<random>",
  "contractVersion": 1,
  "pid": 12345
}
```

- The token is random for each daemon launch and is never stored elsewhere.
  Turning the feature off, or the daemon closing, deletes the file, ends every
  session, and refuses the old token.
- The token only authorizes `/external-mcp`. The daemon's own token never
  leaves the desktop process, as described in the
  [trust boundary](runtime.md#trust-boundary).
- Any process of the same user can read the file. This matches the existing
  local trust model, in which provider credentials are stored in the same
  user's data directory.

### The daemon endpoint

`POST /external-mcp` takes MCP JSON-RPC messages in the Streamable HTTP style
and answers with JSON; nothing is streamed, so `GET` returns 405.

- `initialize` creates a session and returns it in `Mcp-Session-Id`. Later
  requests without the header get 400; an unknown or expired session gets 404,
  telling the client to initialize again. `DELETE` ends a session. Sessions
  idle for six hours end.
- `X-OhMyGame-Roots` carries a JSON array of absolute paths or `file:` URLs:
  the launcher sends the client's MCP roots, falling back to its working
  directory. The first one inside a project's workspace binds the session to
  that project until `open_project` chooses one explicitly.
- `instructions` in the `initialize` result give a short usage guide, so
  clients without the Skill still know about projects and jobs.

### Launcher (milestone 2)

- The app writes `<userData>/bin/ohmygame-mcp` (`ohmygame-mcp.cmd` on
  Windows) on every start. It runs the bundled launcher script with the app's
  own runtime (`ELECTRON_RUN_AS_NODE=1`), so no Node.js installation is
  needed, and keeps a stable path when the app moves or updates.
- It answers `initialize` and `tools/list` from a copy of the tool list the
  daemon saves next to `endpoint.json`. Clients start every configured MCP
  server when a session opens, in any folder, so the app must not start just
  because a client did.
- The first `tools/call` starts OhMyGame if `endpoint.json` is missing or its
  `pid` is gone, waiting up to 30 seconds. A tool call is a clear request to
  use OhMyGame, and `game_use` needs the app anyway.
- While a request is in flight, it sends `notifications/progress` for the
  client's progress token, so clients that reset timeouts on progress keep
  waiting.
- It refuses to start when `OHMYGAME_EXTERNAL_MCP_DISABLED=1`. The daemon sets
  this for the coding agent CLIs it runs, so a Claude Code conversation inside
  OhMyGame that loads the person's own MCP configuration does not connect
  back to OhMyGame.

## Public tools

Every session lists the same tools, whichever project it uses. A tool the
bound project does not have returns an error that says why.

| Tool                                                                        | Notes                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list_projects`, `open_project`, `get_project`                              | Project ID, name, type and workspace folder; `open_project` by ID or folder |
| `get_job`, `wait_job`, `cancel_job`                                         | Generation jobs, see below                                                  |
| `generate_image`, `generate_video`, `generate_3d_asset`, `animate_3d_asset` | Run as jobs                                                                 |
| `generate_speech`, `generate_sound_effect`, `generate_music`                | Run as jobs                                                                 |
| `canvas_check`, `canvas_initialize`, `generate_canvas_media`                | `generate_canvas_media` runs as a job                                       |
| `game_use`                                                                  | Needs the desktop app and a project with a game preview; opens a window     |
| `playable_add_node`, `playable_check`                                       | Interactive Story projects only                                             |

`game_use` lists the full web game input; a story project's own tool accepts
the subset its player supports.

Not offered: Pi's file and shell tools (`read`, `write`, `edit`, `bash`,
`grep`, `find`, `ls`, `recall_image`), which the client has; `questionnaire`
and `update_plan`, since the client asks and plans itself; `install_plugin`,
`web_search`, and the plugin `mcp` passthrough. Plugin services can be
reconsidered later.

Generated files are saved in the project workspace and its Asset Library.
Results name each file's workspace-relative path; the agent reads it with its
own tools.

### Versioning

- `serverInfo.version` and `contractVersion` are the contract version (`1`).
- Adding tools or optional parameters is compatible. Renaming, removing, or
  changing the meaning of a tool or parameter is not: add a new name and keep
  the old one, marked deprecated in its description, for at least two
  releases.
- `test/external-mcp.test.ts` asserts the listed tool names, so a change to
  the public list fails until it is made deliberately.

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

## Visibility and Undo

- (Milestone 2) Each client and project pair records its tool calls and results
  in a read-only **External: `<client>`** conversation, using the same
  `observe` path as the coding agent bridge, so the person can see what an
  outside agent did and spent.
- Files written by OhMyGame tools go through `ProjectWrites` and the canvas
  store as they do for OhMyGame's agent, so the open app updates live. Files
  the external agent edits with its own tools bypass OhMyGame checkpoints and
  cannot be undone from the app.
- A session's playtest windows close when the session ends, changes project,
  or its project is deleted.

## Skill and client packages

- (Milestone 4) `integrations/agent-plugin/skills/ohmygame/SKILL.md` carries
  the workflow in the Anthropic Skill format, which Claude Code, Codex and
  `dsh` read. It names public tools only. Adapting the bundled studio Skills
  (Web Game Studio, Game Playtest) is a follow-up; they assume Pi's context.
- The package lives under `integrations/`, not `plugins/`: the plugin loader
  reads `.claude-plugin` and `.codex-plugin` manifests there and would offer
  it to OhMyGame's own agent.

(Milestone 3) **Connect external agents** in Settings → Agents reuses agent
runtime discovery to find each CLI and writes one user-level entry named
`ohmygame`; disconnecting removes it.

| Client      | MCP entry                                                                            | Skill                                    |
| ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| Claude Code | Plugin with `.claude-plugin`                                                         | In the plugin                            |
| Codex       | Plugin with `.codex-plugin`, or `[mcp_servers.ohmygame]`                             | In the plugin, or the user Skills folder |
| dsh         | `@deepseek-ai/dsh-mcp-client` insert in `~/.dsh/profiles/<profile>/cordis.patch.yml` | `~/.agents/skills/ohmygame`              |

Manual configuration, where `<launcher>` is the path shown in Settings:

```sh
claude mcp add --scope user ohmygame -- "<launcher>"
```

```toml
# ~/.codex/config.toml
[mcp_servers.ohmygame]
command = "<launcher>"
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: mcp-ohmygame
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: ohmygame
        transport: stdio
        command: "<launcher>"
```

Client configuration formats change between releases; the writers keep
per-client tests, and formats are checked against each client's current
documentation when they are implemented.

## Milestones

1. **Server (done).** `/external-mcp`, sessions, project binding, public tool
   list, jobs, settings route, endpoint file and per-launch token.
2. **Launcher.** Launcher with its saved tool list, app start, roots, progress
   and recursion guard; External conversation record.
3. **Connect UI.** Settings section, per-client configuration writers,
   English and Simplified Chinese text.
4. **Skill and packages.** `ohmygame` Skill, Claude and Codex packages,
   README section in both languages.
5. **Follow-ups.** MCP resources (design doc, canvas, asset list), adapted
   studio Skills, publishing, plugin services, delegation.

Acceptance for each client: connect from Settings, open a project folder,
generate an image and a 3D model through `wait_job`, playtest with
`game_use`, see the calls in the External conversation, then disconnect and
confirm the old token is refused.

Until the launcher exists, the server can be tried with an MCP client that
supports Streamable HTTP and custom headers, using the URL and token from
`endpoint.json` and an `X-OhMyGame-Roots` header naming a project folder.
